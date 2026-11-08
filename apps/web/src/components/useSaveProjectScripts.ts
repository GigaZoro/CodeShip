import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  ProjectScriptExistsError,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ProjectScriptMutation,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectScriptIdsInSettings, resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { t } from "~/i18n";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdsInUse,
} from "../projectScripts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  projectScriptShortcutFailure,
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "./projectScriptEditor";

export type ProjectScriptChange =
  /** A null `scriptId` adds a new action. */
  | {
      readonly kind: "save";
      readonly scriptId: string | null;
      readonly input: NewProjectScriptInput;
    }
  | { readonly kind: "delete"; readonly scriptId: string }
  | { readonly kind: "reset" };

export interface ProjectScriptList {
  readonly environmentId: EnvironmentId;
  /** Null for the environment's default actions. */
  readonly projectId: ProjectId | null;
}

const isProjectScriptExistsError = Schema.is(ProjectScriptExistsError);

const fail = (error: Error): ProjectScriptActionResult => AsyncResult.failure(Cause.fail(error));

const environmentProjectsOf = (environmentId: EnvironmentId) =>
  appAtomRegistry
    .get(environmentProjects.projectsAtom)
    .filter((project) => project.environmentId === environmentId);

/** Shortcuts are keyed by action id across an environment, so a new id must be free in each one. */
function idsInUse(lists: readonly ProjectScriptList[]): string[] {
  return lists.flatMap(({ environmentId }) => {
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if (!config) return [];
    return [
      ...projectScriptIdsInUse({
        settings: config.settings,
        projects: environmentProjectsOf(environmentId),
        keybindings: config.keybindings,
      }),
    ];
  });
}

function listScripts(
  settings: ServerSettings,
  projects: readonly EnvironmentProject[],
  projectId: ProjectId | null,
): readonly ProjectScript[] {
  if (projectId === null) return settings.defaultProjectScripts;
  const project = projects.find((candidate) => candidate.id === projectId);
  return resolveProjectScripts(settings, project ?? { id: projectId, scripts: [] });
}

/**
 * The one way clients change actions. The server applies each change to the list it holds, and
 * this reads settings, projects and shortcuts when it runs rather than from the last render, so
 * saves started back to back or from other clients keep each other's actions.
 */
export function useSaveProjectScripts() {
  const updateProjectScripts = useAtomCommand(serverEnvironment.updateProjectScripts, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });

  const syncShortcut = async (
    environmentId: EnvironmentId,
    scriptId: string,
    keybinding: string | null,
  ): Promise<ProjectScriptActionResult> => {
    const command = commandForProjectScript(scriptId);
    if (command === null) return AsyncResult.success(undefined);
    const bindings =
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.keybindings ?? [];
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
      const result = await removeKeybinding({ environmentId, input: rule });
      if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
    }
    if (!next) return AsyncResult.success(undefined);
    return mapAtomCommandResult(
      await upsertKeybinding({
        environmentId,
        input: previous && previous.key !== next.key ? { ...next, replace: previous } : next,
      }),
      () => undefined,
    );
  };

  const saveList = async (
    environmentId: EnvironmentId,
    mutation: ProjectScriptMutation,
    keybinding: string | null | undefined,
  ): Promise<ProjectScriptActionResult> => {
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const projects = environmentProjectsOf(environmentId);
    const before = config ? listScripts(config.settings, projects, mutation.projectId) : [];
    const written = await updateProjectScripts({ environmentId, input: mutation });
    if (written._tag === "Failure") {
      return isProjectScriptExistsError(squashAtomCommandFailure(written))
        ? fail(
            new Error(t("Another action with this name was just added. Save again to add yours.")),
          )
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
      const result = await syncShortcut(environmentId, scriptId, shortcut);
      if (result._tag === "Failure") {
        return kept ? projectScriptShortcutFailure(scriptId, result) : result;
      }
    }
    return AsyncResult.success(undefined);
  };

  /** Changes every list in turn and stops at the first that fails. */
  return useStableCallback(
    async (
      lists: readonly ProjectScriptList[],
      change: ProjectScriptChange,
    ): Promise<ProjectScriptActionResult> => {
      if (lists.length === 0) return fail(new Error(t("No machine is available.")));
      for (const { environmentId } of lists) {
        if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
          return fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthSettingsWriteScope,
              message: t("This connection cannot change project actions."),
            }),
          );
        }
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
        if (config && config.environment.capabilities.projectScriptMutations !== true) {
          return fail(new Error(t("Update this environment's server to change its actions.")));
        }
      }
      let mutationFor: (projectId: ProjectId | null) => ProjectScriptMutation;
      if (change.kind === "save") {
        const script = buildProjectScript(
          change.scriptId ?? nextProjectScriptId(change.input.name, idsInUse(lists)),
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
        const operation = change.scriptId === null ? "add" : "upsert";
        mutationFor = (projectId) => ({ operation, projectId, script });
      } else if (change.kind === "delete") {
        mutationFor = (projectId) => ({
          operation: "remove",
          projectId,
          scriptId: change.scriptId,
        });
      } else {
        mutationFor = (projectId) => ({ operation: "reset", projectId });
      }
      const keybinding = change.kind === "save" ? change.input.keybinding : null;
      for (const { environmentId, projectId } of lists) {
        const result = await saveList(environmentId, mutationFor(projectId), keybinding);
        if (result._tag === "Failure") return result;
      }
      return AsyncResult.success(undefined);
    },
  );
}
