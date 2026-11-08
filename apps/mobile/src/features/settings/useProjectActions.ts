import { AuthSettingsWriteScope, EnvironmentId, type ProjectId } from "@t3tools/contracts";
import {
  saveProjectScripts,
  type ProjectScriptChange,
  type ProjectScriptSaveResult,
} from "@t3tools/client-runtime/state/projectScriptSaves";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveProjectScripts, type ProjectScriptInput } from "@t3tools/shared/projectScripts";
import { useMemo, useState } from "react";

import { t } from "../../lib/i18n";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** A project checkout whose actions an editor changes. */
export interface ProjectActionTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export type ProjectActionWriteResult =
  | { readonly ok: true }
  /** `message` is null when the write was interrupted rather than refused. */
  | { readonly ok: false; readonly message: string | null };

function writeResult(result: ProjectScriptSaveResult): ProjectActionWriteResult {
  if (result._tag === "Success") return { ok: true };
  if (isAtomCommandInterrupted(result)) return { ok: false, message: null };
  const error = squashAtomCommandFailure(result);
  return {
    ok: false,
    message: error instanceof Error ? error.message : t("Failed to save project actions"),
  };
}

/** The checkouts' actions, changed through the same server mutation web uses. */
export function useProjectActions(targets: readonly ProjectActionTarget[]) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const resolved = targets.flatMap((target) => {
    const environment = environments.find(
      (entry) =>
        entry.environmentId === target.environmentId && entry.connection.phase === "connected",
    );
    const project = projects.find(
      (entry) => entry.environmentId === target.environmentId && entry.id === target.projectId,
    );
    if (!environment?.serverConfig || !project) return [];
    return [
      {
        scripts: resolveProjectScripts(environment.serverConfig.settings, project),
        serverSavesActions:
          environment.serverConfig.environment.capabilities.projectScriptMutations === true,
      },
    ];
  });
  const scripts = resolved[0]?.scripts ?? [];
  const serializedScripts = JSON.stringify(scripts);
  const mixed = resolved.some((target) => JSON.stringify(target.scripts) !== serializedScripts);

  const environmentKey = [...new Set(targets.map((target) => target.environmentId))].join("\n");
  // The scope hook builds an atom per list, so keep the list stable across renders.
  const scopeEnvironments = useMemo(
    () =>
      environmentKey === ""
        ? []
        : environmentKey.split("\n").map((id) => ({ environmentId: EnvironmentId.make(id) })),
    [environmentKey],
  );
  const writable = useEnvironmentsWithScope(scopeEnvironments, AuthSettingsWriteScope);
  const readOnlyReason =
    targets.length === 0 || resolved.length < targets.length
      ? t("Connect every machine with this project to change this.")
      : !resolved.every((target) => target.serverSavesActions)
        ? t("Update this environment's server to change its actions.")
        : targets.every((target) => writable.has(target.environmentId))
          ? null
          : t("This connection cannot change project actions.");

  const [saving, setSaving] = useState(false);
  const updateProjectScripts = useAtomCommand(serverEnvironment.updateProjectScripts, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });

  const change = (projectScriptChange: ProjectScriptChange) => {
    setSaving(true);
    return saveProjectScripts(
      {
        config: (environmentId) =>
          appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
        projects: (environmentId) =>
          appAtomRegistry
            .get(environmentProjects.projectsAtom)
            .filter((project) => project.environmentId === environmentId),
        canWriteSettings: (environmentId) =>
          readEnvironmentScope(environmentId, AuthSettingsWriteScope),
        updateProjectScripts,
        upsertKeybinding,
        removeKeybinding,
      },
      targets,
      projectScriptChange,
    )
      .then(writeResult)
      .finally(() => setSaving(false));
  };

  return {
    scripts,
    mixed,
    readOnlyReason,
    saving,
    /** Adds the action when `scriptId` is null; an edit keeps its shortcut, set on desktop. */
    save: (scriptId: string | null, input: ProjectScriptInput) =>
      change({ kind: "save", scriptId, input }),
    remove: (scriptId: string) => change({ kind: "delete", scriptId }),
  };
}
