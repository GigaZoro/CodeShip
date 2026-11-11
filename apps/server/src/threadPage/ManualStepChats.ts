import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  isProviderAvailable,
  type ManualStepDecision,
  ManualStepStartChatError,
  type ManualStepStartChatFailure,
  type ManualStepStartChatInput,
  type ManualStepStartChatResult,
  MessageId,
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const MAX_TITLE_LENGTH = 120;

export class ManualStepChats extends Context.Service<
  ManualStepChats,
  {
    /** Starts a chat in No project whose first message is the step and the user's decision. */
    readonly start: (input: ManualStepStartChatInput) => Effect.Effect<
      /** `resumed` when this request repeats one that already started the chat. */
      ManualStepStartChatResult & { readonly resumed: boolean },
      ManualStepStartChatError
    >;
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

type Providers = ReadonlyArray<ServerProvider>;

const canRunTurns = (
  provider: ServerProvider,
  settings: ServerSettingsValue,
  projectId: ProjectId,
) =>
  provider.enabled &&
  provider.installed &&
  provider.auth.status !== "unauthenticated" &&
  isProviderAvailable(provider) &&
  resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId);

/**
 * The selection on an account that can run a turn, or null. The card has no model picker, so a
 * default that cannot run would leave the decision undone. An auto-account selection moves to
 * another account of its provider, since the launch refuses a turned-off account before routing.
 */
function runnableSelection(
  selection: ModelSelection,
  providers: Providers,
  settings: ServerSettingsValue,
  projectId: ProjectId,
): ModelSelection | null {
  const own = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (own === undefined) return null;
  if (canRunTurns(own, settings, projectId)) return selection;
  const sibling =
    selection.autoAccount === true
      ? providers.find(
          (provider) =>
            provider.driver === own.driver && canRunTurns(provider, settings, projectId),
        )
      : undefined;
  return sibling === undefined ? null : { ...selection, instanceId: sibling.instanceId };
}

/** The first account that can run a turn, on its default model. */
function firstRunnableSelection(
  providers: Providers,
  settings: ServerSettingsValue,
  projectId: ProjectId,
): ModelSelection | null {
  for (const provider of providers) {
    const model =
      provider.models.find((candidate) => candidate.isDefault)?.slug ?? provider.models[0]?.slug;
    if (model !== undefined && canRunTurns(provider, settings, projectId)) {
      return { instanceId: provider.instanceId, model };
    }
  }
  return null;
}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* Project.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const start: ManualStepChats["Service"]["start"] = Effect.fn("ManualStepChats.start")(
    function* (input) {
      // A step belongs to a machine's pending list, not to a project.
      const { projectId } = yield* managedFolders.ensureScratchProject.pipe(
        Effect.mapError((error) => failure("launch-failed", error.message)),
      );
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => failure("launch-failed", "Could not read the model settings.")),
      );
      const project = Option.getOrUndefined(
        yield* projects
          .getById(projectId)
          .pipe(
            Effect.mapError(() =>
              failure("launch-failed", "Could not read the No project folder."),
            ),
          ),
      );
      const defaults = resolveProjectSettings(settings, projectId, project).settings;
      // The thread takes the command's id, so a repeated request finds the chat it already
      // started and replays it on that chat's model, whatever the accounts look like by now.
      const threadId = ThreadId.make(input.commandId);
      const started = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => failure("launch-failed", "Could not read the chat.")));
      const startedModel =
        started === null || started.deletedAt !== null ? null : started.modelSelection;
      const pickModel = Effect.gen(function* () {
        const providers = yield* providerRegistry.getProviders;
        const preferred = resolveNewThreadModelSelection({
          defaultSelection: defaults.defaultModelSelection,
          fallbackSelection: defaults.fallbackModelSelection,
          providers,
          settings: defaults,
          projectId,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        }).selection;
        return (
          (preferred === null
            ? null
            : runnableSelection(preferred, providers, defaults, projectId)) ??
          firstRunnableSelection(providers, defaults, projectId)
        );
      });
      const modelSelection = startedModel ?? (yield* pickModel);
      if (modelSelection === null) {
        return yield* failure(
          "no-model",
          "No provider account on this machine is signed in and enabled.",
        );
      }
      const launched = yield* threadLaunch
        .launch({
          commandId: input.commandId,
          threadId,
          projectId,
          title: manualStepChatTitle(input.step),
          modelSelection,
          runtimeMode: defaults.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(input.commandId),
            text: manualStepDecisionMessage(input.step, input.decision),
            attachments: [],
          },
          createdBy: "user",
          creationSource: input.creationSource ?? "web",
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              error._tag === "ThreadManagementProviderInstanceDisabledError"
                ? "no-model"
                : "launch-failed",
              error.message,
            ),
          ),
        );
      return { threadId: launched.threadId, resumed: launched.resumed };
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
