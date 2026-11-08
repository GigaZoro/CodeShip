import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  ProjectScriptExistsError,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ProjectScriptMutation,
  type ServerConfig,
  type ServerRemoveKeybindingInput,
  type ServerSettings,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { keybindingValueForCommand } from "@t3tools/shared/keybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  decodeProjectScriptKeybindingRule,
  nextProjectScriptId,
  projectScriptIdsInSettings,
  projectScriptIdsInUse,
  resolveProjectScripts,
  type ProjectScriptInput,
} from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import {
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";

/** An editor's fields plus its shortcut text; omit `keybinding` to keep the current shortcut. */
export interface ProjectScriptSaveInput extends ProjectScriptInput {
  readonly keybinding?: string | null;
}

export type ProjectScriptChange =
  /** A null `scriptId` adds a new action. */
  | {
      readonly kind: "save";
      readonly scriptId: string | null;
      readonly input: ProjectScriptSaveInput;
    }
  | { readonly kind: "delete"; readonly scriptId: string }
  | { readonly kind: "reset" };

export interface ProjectScriptList {
  readonly environmentId: EnvironmentId;
  /** Null for the environment's default actions. */
  readonly projectId: ProjectId | null;
}

export type ProjectScriptSaveResult = AtomCommandResult<void, unknown>;

/** The action itself was saved, so saving again must edit it rather than add a copy. */
export class ProjectScriptShortcutError extends Error {
  readonly scriptId: string;

  constructor(scriptId: string, reason: string) {
    super(t("The action was saved, but its shortcut was not: {reason}", { reason }));
    this.scriptId = scriptId;
  }
}

function projectScriptShortcutFailure(
  scriptId: string,
  failure: { readonly cause: Cause.Cause<unknown> },
): ProjectScriptSaveResult {
  const error = squashAtomCommandFailure(failure);
  return AsyncResult.failure(
    Cause.fail(
      new ProjectScriptShortcutError(
        scriptId,
        error instanceof Error ? error.message : t("An unexpected error occurred."),
      ),
    ),
  );
}

type Command<I, A> = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: I;
}) => Promise<AtomCommandResult<A, unknown>>;

/** What a client reads and runs; reads happen when a save runs, never from the last render. */
export interface ProjectScriptSaveContext {
  readonly config: (
    environmentId: EnvironmentId,
  ) => Pick<ServerConfig, "settings" | "keybindings" | "environment"> | null;
  readonly projects: (
    environmentId: EnvironmentId,
  ) => readonly { readonly id: ProjectId; readonly scripts: readonly ProjectScript[] }[];
  readonly canWriteSettings: (environmentId: EnvironmentId) => boolean;
  readonly updateProjectScripts: Command<ProjectScriptMutation, ServerSettings>;
  readonly upsertKeybinding: Command<ServerUpsertKeybindingInput, unknown>;
  readonly removeKeybinding: Command<ServerRemoveKeybindingInput, unknown>;
}

const isProjectScriptExistsError = Schema.is(ProjectScriptExistsError);

const fail = (error: Error): ProjectScriptSaveResult => AsyncResult.failure(Cause.fail(error));

function listScripts(
  settings: ServerSettings,
  projects: ReturnType<ProjectScriptSaveContext["projects"]>,
  projectId: ProjectId | null,
): readonly ProjectScript[] {
  if (projectId === null) return settings.defaultProjectScripts;
  const project = projects.find((candidate) => candidate.id === projectId);
  return resolveProjectScripts(settings, project ?? { id: projectId, scripts: [] });
}

async function syncShortcut(
  context: ProjectScriptSaveContext,
  environmentId: EnvironmentId,
  scriptId: string,
  keybinding: string | null,
): Promise<ProjectScriptSaveResult> {
  const command = commandForProjectScript(scriptId);
  if (command === null) return AsyncResult.success(undefined);
  const bindings = context.config(environmentId)?.keybindings ?? [];
  if (keybindingValueForCommand(bindings, command) === (keybinding?.trim() || null)) {
    return AsyncResult.success(undefined);
  }
  const next = decodeProjectScriptKeybindingRule({ keybinding, command });
  const previousRules = bindings.flatMap((binding) => {
    if (binding.command !== command || binding.whenAst) return [];
    const previous = decodeProjectScriptKeybindingRule({
      keybinding: keybindingValueForCommand([binding], command),
      command,
    });
    return previous ? [previous] : [];
  });
  const previous = previousRules.at(-1);
  for (const rule of next ? previousRules.slice(0, -1) : previousRules) {
    const result = await context.removeKeybinding({ environmentId, input: rule });
    if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
  }
  if (!next) return AsyncResult.success(undefined);
  return mapAtomCommandResult(
    await context.upsertKeybinding({
      environmentId,
      input: previous && previous.key !== next.key ? { ...next, replace: previous } : next,
    }),
    () => undefined,
  );
}

async function saveList(
  context: ProjectScriptSaveContext,
  environmentId: EnvironmentId,
  mutation: ProjectScriptMutation,
  keybinding: string | null | undefined,
): Promise<ProjectScriptSaveResult> {
  const config = context.config(environmentId);
  const projects = context.projects(environmentId);
  const before = config ? listScripts(config.settings, projects, mutation.projectId) : [];
  const written = await context.updateProjectScripts({ environmentId, input: mutation });
  if (written._tag === "Failure") {
    return isProjectScriptExistsError(squashAtomCommandFailure(written))
      ? fail(new Error(t("Another action with this name was just added. Save again to add yours.")))
      : mapAtomCommandResult(written, () => undefined);
  }

  const after = written.value;
  const remaining = listScripts(after, projects, mutation.projectId);
  const shortcuts: ReadonlyArray<readonly [string, string | null]> =
    mutation.operation === "add" || mutation.operation === "upsert"
      ? keybinding === undefined
        ? []
        : [[mutation.script.id, keybinding]]
      : before
          .filter((script) => !remaining.some((next) => next.id === script.id))
          .map((script) => [script.id, null] as const);
  for (const [scriptId, shortcut] of shortcuts) {
    const kept = remaining.some((script) => script.id === scriptId);
    // Another list may still hold the action, and its shortcut with it.
    const retained =
      !kept &&
      (projectScriptIdsInSettings(after).has(scriptId) ||
        projects.some((project) =>
          resolveProjectScripts(after, project).some((script) => script.id === scriptId),
        ));
    if (retained) continue;
    const result = await syncShortcut(context, environmentId, scriptId, shortcut);
    if (result._tag === "Failure") {
      return kept ? projectScriptShortcutFailure(scriptId, result) : result;
    }
  }
  return AsyncResult.success(undefined);
}

/**
 * The one way clients change actions. The server applies each change to the list it holds, and
 * this reads settings, projects and shortcuts when it runs, so saves started back to back or from
 * other clients keep each other's actions. It changes every list in turn and stops at the first
 * that fails.
 */
export async function saveProjectScripts(
  context: ProjectScriptSaveContext,
  lists: readonly ProjectScriptList[],
  change: ProjectScriptChange,
): Promise<ProjectScriptSaveResult> {
  if (lists.length === 0) return fail(new Error(t("No machine is available.")));
  for (const { environmentId } of lists) {
    if (!context.canWriteSettings(environmentId)) {
      return fail(
        new EnvironmentAuthorizationError({
          requiredScope: AuthSettingsWriteScope,
          message: t("This connection cannot change project actions."),
        }),
      );
    }
    const config = context.config(environmentId);
    if (config && config.environment.capabilities.projectScriptMutations !== true) {
      return fail(new Error(t("Update this environment's server to change its actions.")));
    }
  }
  let mutationFor: (list: ProjectScriptList) => ProjectScriptMutation;
  // An added action's id is then taken in its environment, so its other lists there upsert it.
  const addedIn = new Set<EnvironmentId>();
  if (change.kind === "save") {
    // Shortcuts are keyed by action id across an environment, so a new id must be free in each one.
    const idsInUse = lists.flatMap(({ environmentId }) => {
      const config = context.config(environmentId);
      if (!config) return [];
      return [
        ...projectScriptIdsInUse({
          settings: config.settings,
          projects: context.projects(environmentId),
          keybindings: config.keybindings,
        }),
      ];
    });
    const script = buildProjectScript(
      change.scriptId ?? nextProjectScriptId(change.input.name, idsInUse),
      change.input,
    );
    // Refuse a malformed shortcut before the action is written without it.
    try {
      decodeProjectScriptKeybindingRule({
        keybinding: change.input.keybinding,
        command: commandForProjectScript(script.id),
      });
    } catch (error) {
      return fail(error instanceof Error ? error : new Error(String(error)));
    }
    mutationFor = ({ environmentId, projectId }) => {
      if (change.scriptId !== null || addedIn.has(environmentId)) {
        return { operation: "upsert", projectId, script };
      }
      addedIn.add(environmentId);
      return { operation: "add", projectId, script };
    };
  } else if (change.kind === "delete") {
    mutationFor = ({ projectId }) => ({
      operation: "remove",
      projectId,
      scriptId: change.scriptId,
    });
  } else {
    mutationFor = ({ projectId }) => ({ operation: "reset", projectId });
  }
  const keybinding = change.kind === "save" ? change.input.keybinding : null;
  for (const list of lists) {
    const result = await saveList(context, list.environmentId, mutationFor(list), keybinding);
    if (result._tag === "Failure") return result;
  }
  return AsyncResult.success(undefined);
}
