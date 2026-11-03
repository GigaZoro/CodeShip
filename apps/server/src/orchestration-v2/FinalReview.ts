import {
  CommandId,
  isListedThreadLineage,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const MAX_LISTED_FILES = 30;

type FinalReviewSettings = Pick<
  ServerSettingsValue,
  "finalReviewByDefault" | "finalReviewModelSelections" | "finalReviewInstructions"
>;

/** How the coordinator names a reviewer for `delegate_task`; Auto account rides on the settings match. */
function reviewerTarget(selection: ModelSelection) {
  return {
    providerInstanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options === undefined || selection.options.length === 0
      ? {}
      : { options: Object.fromEntries(selection.options.map(({ id, value }) => [id, value])) }),
  };
}

function reviewerLabel(selection: ModelSelection, provider: ServerProvider | undefined) {
  const model =
    provider?.models.find((candidate) => candidate.slug === selection.model)?.name ??
    selection.model;
  return provider?.displayName ? `${model} (${provider.displayName})` : model;
}

/**
 * The message that asks a thread's agent to have its changes reviewed, once the turn a person
 * started has finished and changed files. Null when no review is due.
 */
export function finalReviewCommand(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "checkpoints"
  >;
  readonly runId: RunId;
  readonly settings: FinalReviewSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
}): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  const { thread } = input.projection;
  if (
    input.settings.finalReviewModelSelections.length === 0 ||
    !(thread.finalReview ?? input.settings.finalReviewByDefault) ||
    thread.archivedAt !== null ||
    !isListedThreadLineage(thread.lineage)
  )
    return null;
  const run = input.projection.runs.find((candidate) => candidate.id === input.runId);
  if (run?.status !== "completed") return null;
  const message = input.projection.messages.find((candidate) => candidate.id === run.userMessageId);
  // Only a request a person sent; the review's own turn and task wake-ups never start another.
  if (
    message === undefined ||
    message.createdBy !== "user" ||
    (message.creationSource !== "web" && message.creationSource !== "mobile")
  )
    return null;
  const checkpoint = input.projection.checkpoints
    .filter((candidate) => candidate.runId === run.id && candidate.status === "ready")
    .toSorted(
      (left, right) =>
        Number(right.nodeId === run.rootNodeId) - Number(left.nodeId === run.rootNodeId) ||
        right.ordinalWithinScope - left.ordinalWithinScope,
    )[0];
  if (checkpoint === undefined || checkpoint.files.length === 0) return null;
  const base = input.projection.checkpoints.find(
    (candidate) => candidate.id === checkpoint.parentCheckpointId,
  );

  const providerOf = (selection: ModelSelection) =>
    input.providers.find((provider) => provider.instanceId === selection.instanceId);
  const reviewers = input.settings.finalReviewModelSelections.map(
    (selection) =>
      `- ${reviewerLabel(selection, providerOf(selection))}: ${JSON.stringify(
        reviewerTarget(selection),
      )}`,
  );
  const files = checkpoint.files.map((file) => file.path);
  const listedFiles =
    files.length > MAX_LISTED_FILES
      ? `${files.slice(0, MAX_LISTED_FILES).join(", ")}, and ${files.length - MAX_LISTED_FILES} more`
      : files.join(", ");
  const scope =
    base === undefined
      ? `the changes to these files (${listedFiles})`
      : `the changes in \`git diff ${base.ref} ${checkpoint.ref}\` (${files.length} ${files.length === 1 ? "file" : "files"}: ${listedFiles})`;
  const instructions = input.settings.finalReviewInstructions.trim();

  const text = [
    "Final review is on for this thread. Before you finish, have each reviewer below check the changes from your last turn.",
    "",
    `1. In this turn, call \`delegate_task\` once per reviewer with \`role: "review"\`, \`mode: "async"\`, the reviewer's \`target\`, and the brief below as \`task\`. Then end your turn.`,
    "2. Reports arrive as task results. When every reviewer has reported, check each finding against the code, fix the real ones, run the checks your fixes affect, and say which findings you dismissed and why. Do not start another final review.",
    "",
    "Reviewers:",
    ...reviewers,
    "",
    "Brief:",
    `Review ${scope}. Work read-only: do not edit files, commit, or change any state. Read enough surrounding code to trace each change's behavior. Look for correctness and edge-case bugs, regressions, security and privacy issues, performance problems, and missing tests. Run the project's own focused checks (typecheck, lint, tests near the changes) when they can confirm or rule out a finding; a skipped or blocked check is not a pass. Report each finding with severity, file and line, impact, and a concrete fix. End with PASS, WARN or FAIL for correctness, security, performance, tests and maintainability, one line each.`,
    ...(instructions === "" ? [] : ["", "Project review instructions:", instructions]),
  ].join("\n");

  const identity = `${thread.id}:${run.id}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`final-review:${identity}`),
    messageId: MessageId.make(`final-review:${identity}`),
    threadId: thread.id,
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "server",
  };
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

    // A run ends before its checkpoint lands, so both events re-check; the command id keeps it once.
    const review = Effect.fn("FinalReview.review")(
      function* (threadId: ThreadId, runId: RunId) {
        const current = yield* settings.getSettings;
        if (current.finalReviewModelSelections.length === 0) return;
        // Most threads have it off; read the thread alone before its runs and checkpoints.
        const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
        if (!(thread.finalReview ?? current.finalReviewByDefault)) return;
        const projection = yield* orchestrator.getThreadRecords(
          threadId,
          ["runs", "messages", "checkpoints"],
          { runIds: [runId], messageRunIds: [runId] },
        );
        const command = finalReviewCommand({
          projection,
          runId,
          settings: current,
          providers: yield* providerRegistry.getProviders,
        });
        if (command === null) return;
        yield* threads.dispatch(command).pipe(
          // A replayed event finds the review already queued.
          Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
        );
      },
      (effect, threadId, runId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.final-review.failed", { threadId, runId, cause }),
          ),
        ),
    );

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type === "checkpoint.captured" && event.payload.runId !== null)
          return review(event.threadId, event.payload.runId);
        if (event.type === "run.updated" && event.payload.status === "completed")
          return review(event.threadId, event.payload.id);
        return Effect.void;
      }),
    );
  }),
);
