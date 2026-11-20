import {
  type CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { canAccountRun } from "@t3tools/shared/serverSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class StartChatAsUserError extends Schema.TaggedError<StartChatAsUserError>()(
  "StartChatAsUserError",
  {
    /** `no-model`: no provider account on this machine is signed in and enabled. */
    reason: Schema.Literals(["no-model", "launch-failed"]),
    detail: Schema.String,
  },
) {}

export interface StartChatAsUserInput {
  /** The chat takes this id, so a repeated request finds the chat it already started. */
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The first message, sent as the user. */
  readonly text: string;
  readonly creationSource: "web" | "mobile";
}

type Providers = ReadonlyArray<ServerProvider>;

/**
 * The selection on an account that can run a turn, or null. These chats have no model picker, so
 * a default that cannot run would leave the work undone. An auto-account selection moves to
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
  if (canAccountRun(own, settings, projectId)) return selection;
  const sibling =
    selection.autoAccount === true
      ? providers.find(
          (provider) =>
            provider.driver === own.driver && canAccountRun(provider, settings, projectId),
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
    if (model !== undefined && canAccountRun(provider, settings, projectId)) {
      return { instanceId: provider.instanceId, model };
    }
  }
  return null;
}

const failure = (reason: StartChatAsUserError["reason"], detail: string) =>
  new StartChatAsUserError({ reason, detail });

/**
 * Starts a chat in the project's root checkout, as the user, on the project's default model or
 * else the first account that can run it. For features that start a chat on the user's behalf.
 */
export const makeStartChatAsUser = Effect.gen(function* () {
  const projects = yield* Project.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  return Effect.fn("startChatAsUser")(function* (input: StartChatAsUserInput) {
    const { projectId } = input;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => failure("launch-failed", "Could not read the model settings.")),
    );
    const project = Option.getOrUndefined(
      yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(() => failure("launch-failed", "Could not read the project."))),
    );
    const defaults = resolveProjectSettings(settings, projectId, project).settings;
    // A repeated request replays on the model its chat started with, whatever the accounts
    // look like by now.
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
    return yield* threadLaunch
      .launch({
        commandId: input.commandId,
        threadId,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: defaults.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(input.commandId),
          text: input.text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: input.creationSource,
      })
      .pipe(
        Effect.map(({ threadId, resumed }) => ({ threadId, resumed })),
        Effect.mapError((error) =>
          failure(
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? "no-model"
              : "launch-failed",
            error.message,
          ),
        ),
      );
  });
});
