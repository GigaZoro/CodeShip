import { MessageId } from "@t3tools/contracts/baseSchemas";
import {
  type ManualStepDecision,
  ManualStepStartChatError,
  type ManualStepStartChatFailure,
  type ManualStepStartChatInput,
} from "@t3tools/contracts/manualSteps";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeStartChatAsUser,
  type StartChatAsUserResult,
} from "../orchestration-v2/startChatAsUser.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

const MAX_TITLE_LENGTH = 120;

export class ManualStepChats extends Context.Service<
  ManualStepChats,
  {
    /** Starts a chat in No project whose first message is the step and the user's decision. */
    readonly start: (
      input: ManualStepStartChatInput,
    ) => Effect.Effect<StartChatAsUserResult, ManualStepStartChatError>;
  }
>()("t3/threadPage/ManualStepChats") {}

const failure = (reason: ManualStepStartChatFailure, detail: string) =>
  new ManualStepStartChatError({ reason, detail });

type Step = ManualStepStartChatInput["step"];

const decisionLines = (decision: ManualStepDecision): ReadonlyArray<string> => {
  if (decision._tag === "Other") return [`My decision: ${decision.text}`];
  const detail = decision.detail.trim();
  const command = decision.command?.trim() ?? "";
  return [
    `My decision: ${decision.title.trim()}`,
    ...(detail.length > 0 ? [detail] : []),
    ...(command.length > 0 ? [`Command: ${command}`] : []),
  ];
};

/** The chat's first message. It is sent as the user, so it speaks in the first person. */
function manualStepDecisionMessage(step: Step, decision: ManualStepDecision): string {
  const money = step.kind === "needs-you";
  return [
    "I decided how to handle this manual step. Carry out my decision.",
    "",
    `Step: ${step.step}`,
    `Kind: ${money ? "money decision" : "hands-on step"}`,
    `Pending list: ${step.machine}`,
    `ThreadPage thread: ${step.title}`,
    step.url,
    "",
    ...decisionLines(decision),
    "",
    // The decision is the only approval: a step being about money approves nothing by itself.
    ...(money
      ? [
          "This step is about money. Spend only what my decision above explicitly approves. If it approves no spending, spend nothing and ask me here first.",
        ]
      : []),
    "Read the ThreadPage thread first: it holds the background. Then do everything in my decision that an agent can do. For anything only I can do, give me the exact steps here and wait for me.",
    "When you finish, add a note to the thread with my decision and the result. Set the thread Done once the step is finished; otherwise leave it Waiting and say what is still needed.",
  ].join("\n");
}

/** The ThreadPage thread's title names the step in a few words; the step itself can run long. */
function manualStepChatTitle(step: Step): string {
  const title = (step.title.trim() || step.step.trim() || "Manual step").replace(/\s+/g, " ");
  return title.length <= MAX_TITLE_LENGTH
    ? title
    : `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const startChatAsUser = yield* makeStartChatAsUser;

  const start: ManualStepChats["Service"]["start"] = Effect.fn("ManualStepChats.start")(
    function* (input) {
      // A step belongs to a machine's pending list, not to a project.
      const { projectId } = yield* managedFolders.ensureScratchProject.pipe(
        Effect.mapError((error) => failure("launch-failed", error.message)),
      );
      return yield* startChatAsUser({
        commandId: input.commandId,
        firstMessageId: MessageId.make(input.commandId),
        projectId,
        title: manualStepChatTitle(input.step),
        text: manualStepDecisionMessage(input.step, input.decision),
        creationSource: input.creationSource ?? "web",
        workspace: "root",
      }).pipe(
        Effect.mapError(
          (error) =>
            new ManualStepStartChatError({
              reason: error.reason,
              detail: error.detail,
              ...(error.quotaAwareAutoUnsupported === true && {
                quotaAwareAutoUnsupported: error.quotaAwareAutoUnsupported,
              }),
            }),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Manual step chat was not started", {
            stepThreadId: input.step.threadId,
            reason: error.reason,
            detail: error.detail,
          }),
        ),
      ),
  );

  return ManualStepChats.of({ start });
});

export const layer = Layer.effect(ManualStepChats, make);
