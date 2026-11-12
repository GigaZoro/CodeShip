import {
  type EnvironmentId,
  type PeerLinkError,
  OrchestratorMcpClaimScheduledTaskOccurrenceResult,
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
  /** `ranOn` skipped it because its run condition found no work, and why. */
  readonly noWork: { readonly reason: string | null } | null;
  /** Machines that could not be asked, and why. */
  readonly unchecked: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly reason: string;
  }>;
}

export interface PeerClaimResult {
  /** The machines that answered, in the order asked, with the holder each one records after the call. */
  readonly answered: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly holder: EnvironmentId;
  }>;
  /** Machines that could not be asked, and why. */
  readonly unchecked: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly reason: string;
  }>;
}

interface PeerAnswer {
  readonly environmentId: EnvironmentId;
  /** Why it could not be asked; null when it answered. */
  readonly reason: string | null;
  readonly has: "working" | "completed" | null;
  readonly noWork: PeerCheckResult["noWork"];
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
    /**
     * Records on each peer's copy that `holder` holds an occurrence of a one-machine task, when it
     * is free there or held by `replaces`.
     */
    readonly claim: (input: {
      readonly taskId: ScheduledTaskId;
      /** When the occurrence was due. */
      readonly occurrence: string;
      readonly holder: EnvironmentId;
      readonly replaces: EnvironmentId | null;
      readonly peers: ReadonlyArray<EnvironmentId>;
    }) => Effect.Effect<PeerClaimResult>;
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

  // Why a machine cannot be asked, from the stored link rather than `list`, which first probes
  // every linked machine; null when it can.
  const linkProblem = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    if (!(yield* links.enabled)) return "Linked environments is turned off here.";
    const link = yield* links.get(environmentId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(link)) return "This machine is not linked.";
    if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, yield* DateTime.now)) {
      return "The link has expired.";
    }
    return null;
  });

  const check: SharedTaskPeerCheck["Service"]["check"] = Effect.fn("SharedTaskPeerCheck.check")(
    function* (input) {
      if (input.peers.length === 0) {
        return { ranOn: null, working: false, noWork: null, unchecked: [] };
      }
      const askOne = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
        const problem = yield* linkProblem(environmentId);
        if (problem !== null) {
          return { environmentId, reason: problem, has: null, noWork: null } satisfies PeerAnswer;
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
            Effect.map((answer): PeerAnswer => {
              const unchecked = (reason: string): PeerAnswer => ({
                environmentId,
                reason,
                has: null,
                noWork: null,
              });
              if (Option.isNone(answer)) return unchecked("It did not answer in time.");
              const task = answer.value.tasks.find(
                (candidate) => candidate.scheduledTaskId === input.taskId,
              );
              if (task === undefined) return unchecked("It does not have this task yet.");
              if (task.lastRun === undefined) {
                return unchecked("It runs an older version of T3.CodeShip.");
              }
              const answered = (has: PeerAnswer["has"], noWork: PeerAnswer["noWork"] = null) => ({
                environmentId,
                reason: null,
                has,
                noWork,
              });
              if (task.checkingSince !== undefined) return answered("working");
              if (
                task.lastSkipped !== undefined &&
                Date.parse(task.lastSkipped.at) >= Date.parse(input.since)
              ) {
                return answered("completed", { reason: task.lastSkipped.reason });
              }
              // A run someone stopped on purpose is settled, so it counts as finished.
              return answered(
                task.lastRun === null ||
                  Date.parse(task.lastRun.at) < Date.parse(input.since) ||
                  (task.lastRun.outcome === "failed" && task.lastRun.stopped !== true)
                  ? null
                  : task.lastRun.outcome === "working"
                    ? "working"
                    : "completed",
              );
            }),
            Effect.catch((error) =>
              Effect.succeed<PeerAnswer>({
                environmentId,
                reason: error.message,
                has: null,
                noWork: null,
              }),
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
        noWork: holder?.noWork ?? null,
        unchecked: answers.flatMap((answer) =>
          answer.reason === null
            ? []
            : [{ environmentId: answer.environmentId, reason: answer.reason }],
        ),
      };
    },
  );

  const claim: SharedTaskPeerCheck["Service"]["claim"] = Effect.fn("SharedTaskPeerCheck.claim")(
    function* (input) {
      const askOne = Effect.fnUntraced(function* (
        environmentId: EnvironmentId,
      ): Effect.fn.Return<
        PeerClaimResult["answered"][number] | PeerClaimResult["unchecked"][number]
      > {
        const problem = yield* linkProblem(environmentId);
        if (problem !== null) return { environmentId, reason: problem };
        return yield* client
          .callIfAvailable({
            environmentId,
            tool: "t3_claim_scheduled_task_occurrence",
            arguments: {
              scheduledTaskId: input.taskId,
              occurrence: input.occurrence,
              holder: input.holder,
              replaces: input.replaces,
            },
            limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
            success: OrchestratorMcpClaimScheduledTaskOccurrenceResult,
          })
          .pipe(
            Effect.timeoutOption(PeerMcpClient.PEER_READ_TIMEOUT),
            Effect.map((answer) =>
              Option.isNone(answer)
                ? { environmentId, reason: "It did not answer in time." }
                : Option.isNone(answer.value)
                  ? { environmentId, reason: "It runs an older version of T3.CodeShip." }
                  : { environmentId, holder: answer.value.value.holder },
            ),
            Effect.catch((error) => Effect.succeed({ environmentId, reason: error.message })),
          );
      });
      const answers = yield* Effect.forEach(input.peers, askOne, { concurrency: "unbounded" });
      return {
        answered: answers.flatMap((answer) => ("holder" in answer ? [answer] : [])),
        unchecked: answers.flatMap((answer) => ("reason" in answer ? [answer] : [])),
      };
    },
  );

  return SharedTaskPeerCheck.of({ linkedEnvironmentIds, linkStatus, check, claim });
});

export const layer = Layer.effect(SharedTaskPeerCheck, make);
