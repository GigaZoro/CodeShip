import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts/baseSchemas";
import {
  OrchestratorMcpClaimScheduledTaskOccurrenceResult,
  OrchestratorMcpScheduledOccurrence,
  OrchestratorMcpScheduledTask,
} from "@t3tools/contracts/orchestratorMcp";
import type { PeerLinkError } from "@t3tools/contracts/peerLink";
import {
  SCHEDULED_TASK_CLAIM_PROTOCOL,
  ScheduledTaskNoWorkSkip,
} from "@t3tools/contracts/scheduledTask";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

// Only what the check reads, and only for this task, so a change to any other field or task in a
// peer's answer never hides its run.
const decodePeerTaskList = Schema.decodeUnknownOption(
  Schema.Struct({
    tasks: Schema.Array(Schema.Unknown),
    claimProtocol: Schema.optional(Schema.Unknown),
  }),
);
const decodePeerTask = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Struct.pick(OrchestratorMcpScheduledTask.fields, [
      "checkingSince",
      "checkingFor",
      "liveRuns",
      "lastRun",
    ]),
    lastSkipped: Schema.optional(
      Schema.Struct({
        ...Struct.pick(ScheduledTaskNoWorkSkip.fields, ["at", "reason"]),
        occurrence: Schema.optional(Schema.NullOr(OrchestratorMcpScheduledOccurrence)),
      }),
    ),
  }),
);

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
  /** Machines where runs of the task, scheduled or started by hand, still work, and how many. */
  readonly liveRunsElsewhere: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly liveRuns: number;
  }>;
  /** Machines that could not be asked, and why. */
  readonly unchecked: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly reason: string;
  }>;
  /**
   * Machines that answered, so they are up, on another claim protocol than this one's or in a way
   * this one cannot read. Each may decide the occurrence is its own whatever this one does.
   */
  readonly otherVersion: ReadonlyArray<EnvironmentId>;
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
  /** It answered, on another claim protocol or in a way this one cannot read. */
  readonly otherVersion: boolean;
  readonly has: "working" | "completed" | null;
  readonly noWork: PeerCheckResult["noWork"];
  readonly liveRuns: number;
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
    readonly check: (input: {
      readonly taskId: ScheduledTaskId;
      readonly peers: ReadonlyArray<EnvironmentId>;
      /** The occurrence, named as claims name it. */
      readonly occurrence: string;
      /** The earliest start that counts as this occurrence's, for a peer that names none. */
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
        return {
          ranOn: null,
          working: false,
          noWork: null,
          liveRunsElsewhere: [],
          unchecked: [],
          otherVersion: [],
        };
      }
      // A late run of the occurrence before starts inside this one's window, so only the occurrence
      // a peer names tells them apart; a later one settles a stale asker too. Null: run now or by
      // a webhook, which is no occurrence's. Absent: an older peer, judged by when it started.
      const counts = (occurrence: string | null | undefined, startedAt: string) =>
        occurrence === undefined
          ? Date.parse(startedAt) >= Date.parse(input.since)
          : occurrence !== null && Date.parse(occurrence) >= Date.parse(input.occurrence);
      const askOne = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
        const unchecked = (reason: string, otherVersion = false): PeerAnswer => ({
          environmentId,
          reason,
          otherVersion,
          has: null,
          noWork: null,
          liveRuns: 0,
        });
        const problem = yield* linkProblem(environmentId);
        if (problem !== null) return unchecked(problem);
        const listed = yield* client
          .call({
            environmentId,
            tool: "list_scheduled_tasks",
            // One task keeps the peer's live-run counts to that task's chats. A version without
            // the filter answers with every task, this one among them.
            arguments: { scheduledTaskId: input.taskId },
            ignorableArguments: ["scheduledTaskId"],
            limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
            success: Schema.Unknown,
          })
          .pipe(
            Effect.timeoutOption(PeerMcpClient.PEER_READ_TIMEOUT),
            Effect.map(
              Option.match({
                onNone: () => unchecked("It did not answer in time."),
                onSome: (answer) => decodePeerTaskList(answer),
              }),
            ),
            // The client recorded an answer it could not read already.
            Effect.catch((error) =>
              Effect.succeed(unchecked(error.message, error.code === "version_mismatch")),
            ),
          );
        if (!Option.isOption(listed)) return listed;
        // It answered, so it is up, but not in a way that says whether it has the occurrence.
        const unreadable = Effect.map(client.recordUnreadable(environmentId), (reason) =>
          unchecked(reason, true),
        );
        if (Option.isNone(listed)) return yield* unreadable;
        const entry = listed.value.tasks.find(
          (candidate) =>
            Predicate.hasProperty(candidate, "scheduledTaskId") &&
            candidate.scheduledTaskId === input.taskId,
        );
        if (entry === undefined) {
          // An entry without an id this version reads may be this task in another shape.
          const unidentified = listed.value.tasks.some(
            (candidate) =>
              !Predicate.hasProperty(candidate, "scheduledTaskId") ||
              typeof candidate.scheduledTaskId !== "string",
          );
          // Without the task it cannot run it, whichever protocol it follows.
          return unidentified ? yield* unreadable : unchecked("It does not have this task yet.");
        }
        const decoded = decodePeerTask(entry);
        if (Option.isNone(decoded)) return yield* unreadable;
        const otherVersion = listed.value.claimProtocol !== SCHEDULED_TASK_CLAIM_PROTOCOL;
        const task = decoded.value;
        // A version before `lastRun` reports no run it started outside the claims.
        if (task.lastRun === undefined) return yield* unreadable;
        // A peer without live-run counts reports only whether its last run's chat works.
        const liveRuns =
          task.liveRuns ??
          (task.lastRun !== null &&
          task.lastRun.outcome === "working" &&
          !counts(task.lastRun.occurrence, task.lastRun.at)
            ? 1
            : 0);
        const answered = (
          has: PeerAnswer["has"],
          noWork: PeerAnswer["noWork"] = null,
        ): PeerAnswer => ({
          environmentId,
          reason: null,
          otherVersion,
          has,
          noWork,
          liveRuns,
        });
        if (task.checkingSince !== undefined && counts(task.checkingFor, task.checkingSince)) {
          return answered("working");
        }
        if (
          task.lastSkipped !== undefined &&
          counts(task.lastSkipped.occurrence, task.lastSkipped.at)
        ) {
          return answered("completed", { reason: task.lastSkipped.reason });
        }
        // A run someone stopped on purpose is settled, so it counts as finished.
        return answered(
          task.lastRun === null ||
            !counts(task.lastRun.occurrence, task.lastRun.at) ||
            (task.lastRun.outcome === "failed" && task.lastRun.stopped !== true)
            ? null
            : task.lastRun.outcome === "working"
              ? "working"
              : "completed",
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
        liveRunsElsewhere: answers.flatMap(({ environmentId, liveRuns }) =>
          liveRuns > 0 ? [{ environmentId, liveRuns }] : [],
        ),
        unchecked: answers.flatMap((answer) =>
          answer.reason === null
            ? []
            : [{ environmentId: answer.environmentId, reason: answer.reason }],
        ),
        otherVersion: answers.flatMap((answer) =>
          answer.otherVersion ? [answer.environmentId] : [],
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
