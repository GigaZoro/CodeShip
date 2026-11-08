import type {
  ProjectId,
  ProjectScript,
  ProjectScriptMutation,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { clearProjectSettingsOverrides } from "./projectSettings.ts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

/** Every action id the environment's settings hold, in its defaults and in each project's list. */
export function projectScriptIdsInSettings(
  settings: Pick<
    ServerSettings,
    "defaultProjectScripts" | "projectScriptOverrides" | "projectSettingsOverrides"
  >,
): Set<string> {
  const ids = new Set<string>();
  const add = (scripts: readonly ProjectScript[] | null | undefined) => {
    for (const script of scripts ?? []) ids.add(script.id);
  };
  add(settings.defaultProjectScripts);
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    add(entry.defaultProjectScripts);
  }
  for (const scripts of Object.values(settings.projectScriptOverrides)) add(scripts);
  return ids;
}

/** One action holds each of the setup and settle roles, so `claimant` takes them from `script`. */
function releaseClaimedRoles(
  script: ProjectScript,
  claimant: Pick<ProjectScript, "runOnWorktreeCreate" | "runOnSettle">,
): ProjectScript {
  const releaseSetup = claimant.runOnWorktreeCreate && script.runOnWorktreeCreate;
  const releaseSettle = claimant.runOnSettle === true && script.runOnSettle === true;
  if (!releaseSetup && !releaseSettle) return script;
  return {
    ...script,
    ...(releaseSetup ? { runOnWorktreeCreate: false } : {}),
    ...(releaseSettle ? { runOnSettle: false } : {}),
  };
}

export function applyProjectScriptChange(
  scripts: readonly ProjectScript[],
  change: Exclude<ProjectScriptMutation, { readonly operation: "reset" }>,
): readonly ProjectScript[] {
  if (change.operation === "remove") {
    return scripts.filter((script) => script.id !== change.scriptId);
  }
  const { script: saved } = change;
  const others = scripts.map((script) =>
    script.id === saved.id ? saved : releaseClaimedRoles(script, saved),
  );
  return scripts.some((script) => script.id === saved.id) ? others : [...others, saved];
}

/**
 * The patch that makes `mutation` against `current`, which must be the settings as the server holds
 * them under its write lock. The caller refuses an `add` whose id is already in use.
 */
export function projectScriptMutationPatch(
  current: ServerSettings,
  mutation: ProjectScriptMutation,
): ServerSettingsPatch {
  const { projectId } = mutation;
  if (projectId === null) {
    return {
      defaultProjectScripts:
        mutation.operation === "reset"
          ? []
          : applyProjectScriptChange(current.defaultProjectScripts, mutation),
    };
  }
  if (mutation.operation === "reset") {
    return {
      projectSettingsOverrides: {
        [projectId]: clearProjectSettingsOverrides(current, projectId, ["defaultProjectScripts"]),
      },
    };
  }
  // Server writes reload and fold legacy project settings first, so a project's own legacy
  // `scripts` never decide what it inherits here.
  const inherited = resolveProjectScripts(current, { id: projectId, scripts: [] });
  return {
    projectSettingsOverrides: {
      [projectId]: {
        ...current.projectSettingsOverrides[projectId],
        defaultProjectScripts: applyProjectScriptChange(inherited, mutation),
      },
    },
  };
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

/** Clients pass translated role labels; this module has no translator. */
export function projectScriptMenuLabel(
  script: ProjectScript,
  roleLabels: { readonly setup: string; readonly settle: string },
): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? [roleLabels.setup] : []),
    ...(script.runOnSettle ? [roleLabels.settle] : []),
  ];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

export function settleProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnSettle === true) ?? null;
}

/**
 * Leading spaces omit scripts from Bash history with ignorespace/ignoreboth,
 * zsh with HIST_IGNORE_SPACE, and fish. Only the first line is prefixed, so later
 * entries from multiline input may still enter history. PowerShell/PSReadLine history is not suppressed.
 */
export function projectScriptTerminalInput(command: string): string {
  return ` ${command}\r`;
}
