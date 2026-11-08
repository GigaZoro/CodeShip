import {
  KeybindingRule,
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectId,
  type ProjectScript,
  type ProjectScriptMutation,
  type ServerSettings,
  type ServerSettingsPatch,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { msg, t } from "./i18n.ts";
import { clearProjectSettingsOverrides } from "./projectSettings.ts";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);
const decodeKeybindingRule = Schema.decodeUnknownOption(KeybindingRule);

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

/** What an action editor saves, before the action has an id. */
export interface ProjectScriptInput {
  readonly name: ProjectScript["name"];
  readonly command: ProjectScript["command"];
  readonly icon: ProjectScript["icon"];
  readonly runOnWorktreeCreate: ProjectScript["runOnWorktreeCreate"];
  readonly waitForSetup: boolean;
  readonly runOnSettle: boolean;
  readonly previewUrl: Exclude<ProjectScript["previewUrl"], undefined> | null;
  readonly autoOpenPreview: boolean;
}

export const EMPTY_PROJECT_SCRIPT_INPUT: ProjectScriptInput = {
  name: "",
  command: "",
  icon: "play",
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  previewUrl: null,
  autoOpenPreview: false,
};

export function projectScriptInputFromScript(script: ProjectScript): ProjectScriptInput {
  return {
    name: script.name,
    command: script.command,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    waitForSetup: script.runOnWorktreeCreate && script.async === false,
    runOnSettle: script.runOnSettle ?? false,
    previewUrl: script.previewUrl ?? null,
    autoOpenPreview: script.autoOpenPreview ?? false,
  };
}

export function buildProjectScript(id: string, input: ProjectScriptInput): ProjectScript {
  return {
    id,
    name: input.name,
    command: input.command,
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    ...(input.runOnWorktreeCreate && input.waitForSetup ? { async: false } : {}),
    ...(input.runOnSettle ? { runOnSettle: true } : {}),
    ...(input.previewUrl === null
      ? {}
      : {
          previewUrl: input.previewUrl,
          autoOpenPreview: input.autoOpenPreview,
        }),
  };
}

/** t3.json actions the list lacks, matched by command or by name ignoring case. */
export function importableT3ProjectFileScripts(
  fileScripts: readonly T3ProjectFileScript[],
  scripts: readonly ProjectScript[],
): readonly T3ProjectFileScript[] {
  return fileScripts.filter(
    (fileScript) =>
      !scripts.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );
}

export function projectScriptInputFromT3File(fileScript: T3ProjectFileScript): ProjectScriptInput {
  return {
    name: fileScript.name,
    command: fileScript.command,
    icon: fileScript.icon ?? "play",
    runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
    waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
    runOnSettle: fileScript.runOnSettle ?? false,
    previewUrl: fileScript.previewUrl ?? null,
    autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
  };
}

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function commandForProjectScript(scriptId: string): KeybindingCommand | null {
  const command = `script.${scriptId}.run`;
  return isScriptRunCommand(command) ? command : null;
}

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  // Each suffix gives a distinct id, so this ends within `taken.size + 1` tries.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
  }
}

/** Shortcuts are keyed by action id across an environment, so a new action needs an id unused anywhere in it. */
export function projectScriptIdsInUse(environment: {
  readonly settings: Pick<
    ServerSettings,
    "defaultProjectScripts" | "projectScriptOverrides" | "projectSettingsOverrides"
  >;
  readonly projects: Iterable<{
    readonly id: ProjectId;
    readonly scripts: readonly ProjectScript[];
  }>;
  readonly keybindings: ReadonlyArray<{ readonly command: string }>;
}): Set<string> {
  const ids = projectScriptIdsInSettings(environment.settings);
  for (const project of environment.projects) {
    for (const script of project.scripts) ids.add(script.id);
  }
  for (const binding of environment.keybindings) {
    const id = projectScriptIdFromCommand(binding.command);
    if (id !== null) ids.add(id);
  }
  return ids;
}

export const PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE = msg("Invalid keybinding.");

/** The shortcut rule an editor's `mod+k` text makes for the action; throws when it is invalid. */
export function decodeProjectScriptKeybindingRule(input: {
  keybinding: string | null | undefined;
  command: KeybindingCommand | null;
}): KeybindingRule | null {
  const key = input.keybinding?.trim() ?? "";
  if (key.length === 0) return null;
  if (input.command === null) {
    throw new Error(t(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE));
  }
  const decoded = decodeKeybindingRule({ key, command: input.command });
  if (decoded._tag === "None") {
    throw new Error(t(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE));
  }
  return decoded.value;
}

export function primaryProjectScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate && !script.runOnSettle);
  return regular ?? scripts.find((script) => !script.runOnSettle) ?? null;
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
