import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { canOpenTcp } from "../cloud/ConnectReachability.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { CONTINUE_PROMPT } from "./RestartContinuation.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// Power cuts and provider outages can last most of a day; an older stop is left to the user.
export const MAX_NETWORK_FAILURE_AGE_MS = 24 * 60 * 60_000;
// Wait before each resume, counted from the failure. The first only waits for the network.
// A resumed run that fails again while the probe says online points at a flaky link or a
// provider-side outage, so later resumes back off, and after the last one the thread stays failed.
const RESUME_DELAYS_MS = [0, 60_000, 5 * 60_000];
// A resumed run that worked this long made progress, so its failure starts a fresh count.
const PROGRESS_MS = 2 * 60_000;
const OFFLINE_RECHECK_MS = 30_000;
const RESUME_ID = /^network-resume:(\d+):/;

// Any of these answering means the internet is back. The providers' own hosts, so a captive
// portal or a LAN-only link does not count.
const PROBE_HOSTS = ["api.anthropic.com", "chatgpt.com"];

/** Where a probe connects: the HTTPS proxy when one is set, since providers go through it. */
export function probeTargets(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<{ readonly host: string; readonly port: number }> {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (proxy !== undefined && URL.canParse(proxy)) {
    const url = new URL(proxy);
    if (url.hostname !== "") {
      return [
        { host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) },
      ];
    }
  }
  return PROBE_HOSTS.map((host) => ({ host, port: 443 }));
}

const canReachProviders = Effect.forEach(
  probeTargets(process.env),
  ({ host, port }) => canOpenTcp(host, port),
  { concurrency: "unbounded" },
).pipe(Effect.map((reached) => reached.some(Boolean)));

/** Whether the internet answers now. Tests replace it. */
export class NetworkProbe extends Context.Reference<Effect.Effect<boolean>>(
  "t3/orchestration-v2/NetworkProbe",
  { defaultValue: () => canReachProviders },
) {}

/** Which resume of an unbroken chain this one is, 1-based. */
function networkResumeAttempt(
  run: Pick<OrchestrationV2Run, "userMessageId" | "startedAt" | "completedAt">,
): number {
  const previous = RESUME_ID.exec(run.userMessageId);
  if (previous === null) return 1;
  const worked =
    run.startedAt !== null &&
    run.completedAt !== null &&
    DateTime.toEpochMillis(run.completedAt) - DateTime.toEpochMillis(run.startedAt) >= PROGRESS_MS;
  return worked ? 1 : Number(previous[1]) + 1;
}

export interface NetworkRecoveryPlan {
  readonly dueAtMs: number;
  readonly command: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" | "prepared-run.retry" }
  >;
}

/**
 * The resume for a thread a lost connection stopped, and when it is due; null to leave it.
 * `setupRetries` counts the setup retries this server already made for the run.
 */
export function networkRecoveryPlan(
  candidate: ProjectionStore.ProjectionNetworkRecoveryCandidate,
  nowMs: number,
  setupRetries = 0,
): NetworkRecoveryPlan | null {
  const { run } = candidate;
  if (run.status !== "failed" || run.completedAt === null) return null;
  const failedAtMs = DateTime.toEpochMillis(run.completedAt);
  if (nowMs - failedAtMs > MAX_NETWORK_FAILURE_AGE_MS) return null;
  if (candidate.setupFailed) {
    // The agent never saw the message, so run the setup and the message again. A retry
    // reuses the run, so the run cannot carry the count the way a resume's message does.
    const delayMs = RESUME_DELAYS_MS[setupRetries];
    if (delayMs === undefined) return null;
    return {
      dueAtMs: failedAtMs + delayMs,
      command: {
        type: "prepared-run.retry",
        automatic: true,
        commandId: CommandId.make(`network-retry-setup:${setupRetries + 1}:${run.id}`),
        threadId: candidate.threadId,
        runId: run.id,
      },
    };
  }
  const attempt = networkResumeAttempt(run);
  const delayMs = RESUME_DELAYS_MS[attempt - 1];
  if (delayMs === undefined) return null;
  // One id per failed run: a repeated tick or a second server cannot resume it twice.
  const id = `network-resume:${attempt}:${run.id}`;
  return {
    dueAtMs: failedAtMs + delayMs,
    command: {
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId: candidate.threadId,
      // The manual resume guard: the failed run must still be the thread's latest.
      manualContinuationOfRunId: run.id,
      automaticContinuationOfRunId: run.id,
      text: CONTINUE_PROMPT,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    },
  };
}

// Events that can make a thread a candidate or take it out; streaming items cannot.
const affectsNetworkRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const isOnline = yield* NetworkProbe;
  const due = DueHint.make();
  // Resumes the orchestrator refused: the thread moved on, so it stays refused.
  const refused = new Set<string>();
  // Setup retries per run since this server started; a restart allows a fresh few.
  const setupRetries = new Map<OrchestrationV2Run["id"], number>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsNetworkRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  return Effect.fn("NetworkRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    if (!(yield* settings.getSettings).retryThreadsAfterNetworkErrors) {
      yield* due.record(readVersion, Infinity, nowMs);
      return;
    }
    const plans = (yield* projections.getNetworkRecoveryCandidates({
      now,
      since: DateTime.makeUnsafe(nowMs - MAX_NETWORK_FAILURE_AGE_MS),
    }))
      .flatMap(
        (candidate) =>
          networkRecoveryPlan(candidate, nowMs, setupRetries.get(candidate.run.id) ?? 0) ?? [],
      )
      .filter((plan) => !refused.has(plan.command.commandId));
    const ready = plans.filter((plan) => plan.dueAtMs <= nowMs);
    let wakeAtMs = Math.min(
      Infinity,
      ...plans.filter((plan) => plan.dueAtMs > nowMs).map((plan) => plan.dueAtMs),
    );
    if (ready.length > 0) {
      if (yield* isOnline) {
        for (const plan of ready) {
          const { command } = plan;
          const dispatch =
            command.type === "prepared-run.retry"
              ? launches
                  .retryPreparation(command)
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() =>
                        setupRetries.set(command.runId, (setupRetries.get(command.runId) ?? 0) + 1),
                      ),
                    ),
                  )
              : threads.dispatch(command);
          yield* dispatch.pipe(
            // The thread moved on since this tick read it: a person resumed it, or another run started.
            Effect.catchTags({
              OrchestratorCommandPreviouslyRejectedError: () =>
                Effect.sync(() => refused.add(plan.command.commandId)),
              OrchestratorDispatchError: () =>
                Effect.sync(() => refused.add(plan.command.commandId)),
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.network-recovery.dispatch-failed", {
                threadId: plan.command.threadId,
                cause,
              }),
            ),
          );
        }
        // The resumed threads stop being candidates; the next tick reads what is left.
        return;
      }
      wakeAtMs = Math.min(wakeAtMs, nowMs + OFFLINE_RECHECK_MS);
    }
    yield* due.record(readVersion, wakeAtMs, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("network-recovery", sweep());
  }),
);
