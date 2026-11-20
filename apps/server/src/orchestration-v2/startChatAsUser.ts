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
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { defaultWorktreeStrategy } from "../vcs/defaultWorktreeStrategy.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
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
  /**
   * `root` runs in the project's checkout. `project-default` starts where a new chat in the
   * project would, so a project set to worktrees gets one from its default branch.
   */
  readonly workspace: "root" | "project-default";
}

/** `resumed` when this request repeats one that already started the chat. */
export type StartChatAsUserResult =
  | { readonly threadId: ThreadId; readonly resumed: true }
  | {
      readonly threadId: ThreadId;
      readonly resumed: false;
      readonly workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy["type"];
    };

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
 * Starts a chat as the user, on the project's default model or else the first account that can
 * run it. For features that start a chat on the user's behalf.
 */
export const makeStartChatAsUser = Effect.gen(function* () {
  const projects = yield* Project.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  /** A folder that is not a git repository has no worktrees, so its chat runs in it, as from the composer. */
  const worktreeIfRepository = (cwd: string) =>
    git.statusDetailsLocal(cwd, { includeDivergence: false }).pipe(
      Effect.mapError(() => failure("launch-failed", "Could not read the project's git status.")),
      Effect.flatMap((status): Effect.Effect<ThreadLaunch.ThreadLaunchWorkspaceStrategy> =>
        status.isRepo ? defaultWorktreeStrategy(git, cwd) : Effect.succeed({ type: "root" }),
      ),
    );

  return Effect.fn("startChatAsUser")(function* (
    input: StartChatAsUserInput,
  ): Effect.fn.Return<StartChatAsUserResult, StartChatAsUserError> {
    const { projectId } = input;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => failure("launch-failed", "Could not read the model settings.")),
    );
    const project = Option.getOrUndefined(
      yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(() => failure("launch-failed", "Could not read the project."))),
    );
    // The project's t3.json can say where new chats run, as it does for the composer.
    const projectFile =
      project === undefined
        ? null
        : Option.getOrNull(yield* projectFiles.load(project.workspaceRoot));
    const defaults = resolveProjectSettings(settings, projectId, project, projectFile).settings;
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
    const workspaceStrategy =
      input.workspace === "project-default" &&
      defaults.defaultThreadEnvMode === "worktree" &&
      project !== undefined
        ? yield* worktreeIfRepository(project.workspaceRoot)
        : ({ type: "root" } as const);
    return yield* threadLaunch
      .launch({
        commandId: input.commandId,
        threadId,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: defaults.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy,
        initialMessage: {
          messageId: MessageId.make(input.commandId),
          text: input.text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: input.creationSource,
      })
      .pipe(
        Effect.map(({ threadId, resumed }): StartChatAsUserResult =>
          resumed
            ? { threadId, resumed }
            : { threadId, resumed, workspaceStrategy: workspaceStrategy.type },
        ),
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
