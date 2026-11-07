import {
  type EnvironmentId,
  type PeerLinkError,
  OrchestratorMcpListScheduledTasksResult,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

interface LinkStatus {
  readonly enabled: boolean;
  readonly links: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly expiresAt: string;
  }>;
}

export interface PeerCheckResult {
  /** The machine that is running or has finished the occurrence; one that finished comes first. */
  readonly ranOn: EnvironmentId | null;
  /** `ranOn` is still running it, so its run may yet fail. */
  readonly working: boolean;
  /** Machines that could not be asked, and why. */
  readonly unchecked: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly reason: string;
  }>;
}

/** Asks linked machines whether they already ran an occurrence of a one-machine task. */
export class SharedTaskPeerCheck extends Context.Service<
  SharedTaskPeerCheck,
  {
    /** Every machine this one has a link to, for tasks whose project has no machine order yet. */
    readonly linkedEnvironmentIds: Effect.Effect<ReadonlyArray<EnvironmentId>>;
    /** Whether links are on here and which are stored, for clients to warn about unchecked machines. */
    readonly linkStatus: Effect.Effect<{
      readonly enabled: boolean;
      readonly links: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly expiresAt: string;
      }>;
    }>;
    /** `since`: the earliest start of a run that counts as this occurrence's. */
    readonly check: (input: {
      readonly taskId: ScheduledTaskId;
      readonly peers: ReadonlyArray<EnvironmentId>;
      readonly since: string;
    }) => Effect.Effect<PeerCheckResult>;
  }
>()("t3/scheduledTasks/SharedTaskPeerCheck") {}

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;

  // Stored links only: `list` first probes every linked machine.
  const linkStatus: SharedTaskPeerCheck["Service"]["linkStatus"] = links.enabled.pipe(
    Effect.flatMap((enabled): Effect.Effect<LinkStatus, PeerLinkError> =>
      enabled
        ? links.listStored.pipe(
            Effect.map((stored) => ({
              enabled,
              links: stored.map((link) => ({
                environmentId: link.environmentId,
                expiresAt: DateTime.formatIso(link.expiresAt),
              })),
            })),
          )
        : Effect.succeed({ enabled, links: [] }),
    ),
    Effect.orElseSucceed((): LinkStatus => ({ enabled: false, links: [] })),
  );
  const linkedEnvironmentIds = linkStatus.pipe(
    Effect.map(({ links: stored }) => stored.map((link) => link.environmentId)),
  );

  const check: SharedTaskPeerCheck["Service"]["check"] = Effect.fn("SharedTaskPeerCheck.check")(
    function* (input) {
      if (input.peers.length === 0) return { ranOn: null, working: false, unchecked: [] };
      const unreachable = (reason: string) => (environmentId: EnvironmentId) =>
        Effect.succeed({ environmentId, reason, has: null });
      const enabled = yield* links.enabled;
      const now = yield* DateTime.now;
      // The stored link, not `list`, which first probes every linked machine.
      const askOne = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
        if (!enabled) {
          return yield* unreachable("Linked environments is turned off here.")(environmentId);
        }
        const link = yield* links.get(environmentId).pipe(Effect.orElseSucceed(Option.none));
        if (Option.isNone(link)) {
          return yield* unreachable("This machine is not linked.")(environmentId);
        }
        if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, now)) {
          return yield* unreachable("The link has expired.")(environmentId);
        }
        return yield* client
          .call({
            environmentId,
            tool: "list_scheduled_tasks",
            arguments: {},
            limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
            success: OrchestratorMcpListScheduledTasksResult,
          })
          .pipe(
            Effect.timeoutOption(PeerMcpClient.PEER_READ_TIMEOUT),
            Effect.map((answer) => {
              if (Option.isNone(answer)) {
                return { environmentId, reason: "It did not answer in time.", has: null };
              }
              const task = answer.value.tasks.find(
                (candidate) => candidate.scheduledTaskId === input.taskId,
              );
              if (task === undefined) {
                return { environmentId, reason: "It does not have this task yet.", has: null };
              }
              if (task.lastRun === undefined) {
                return {
                  environmentId,
                  reason: "It runs an older version of T3.CodeShip.",
                  has: null,
                };
              }
              // A run someone stopped on purpose is settled, so it counts as finished.
              const has =
                task.lastRun === null ||
                Date.parse(task.lastRun.at) < Date.parse(input.since) ||
                (task.lastRun.outcome === "failed" && task.lastRun.stopped !== true)
                  ? null
                  : task.lastRun.outcome === "working"
                    ? "working"
                    : "completed";
              return { environmentId, reason: null, has };
            }),
            Effect.catch((error) =>
              Effect.succeed({ environmentId, reason: error.message, has: null }),
            ),
          );
      });
      const answers = yield* Effect.forEach(input.peers, askOne, { concurrency: "unbounded" });
      const holder =
        answers.find((answer) => answer.has === "completed") ??
        answers.find((answer) => answer.has === "working");
      return {
        ranOn: holder?.environmentId ?? null,
        working: holder?.has === "working",
        unchecked: answers.flatMap((answer) =>
          answer.reason === null
            ? []
            : [{ environmentId: answer.environmentId, reason: answer.reason }],
        ),
      };
    },
  );

  return SharedTaskPeerCheck.of({ linkedEnvironmentIds, linkStatus, check });
});

export const layer = Layer.effect(SharedTaskPeerCheck, make);
