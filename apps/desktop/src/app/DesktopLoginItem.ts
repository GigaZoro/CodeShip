import { t } from "@t3tools/shared/i18n";
import type { DesktopLoginItemState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { runWindowsPowerShell } from "../shell/windowsPowerShell.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopLoginItemError extends Schema.TaggedError<DesktopLoginItemError>()(
  "DesktopLoginItemError",
  { message: Schema.String },
) {}

const UNSUPPORTED: DesktopLoginItemState = {
  supported: false,
  enabled: false,
  requiresApproval: false,
};

/** A value under HKCU\...\CurrentVersion\Run, as Task Manager's Startup apps list shows it. */
export interface WindowsRunEntry {
  readonly name: string;
  readonly command: string;
  /** Turned off in Task Manager or Settings > Apps > Startup. */
  readonly disabled: boolean;
}

export interface WindowsRunRepair {
  /** Entries to delete: earlier names for this install, by hand or by an older version. */
  readonly remove: ReadonlyArray<string>;
  /** Write this install's own entry for the running executable, on or off in Task Manager. */
  readonly write: { readonly enabled: boolean } | null;
}

const normalizeWindowsPath = (value: string) =>
  value.trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();

const windowsDirname = (value: string) => {
  const normalized = normalizeWindowsPath(value);
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf("\\")));
};

/** The executable a Run command starts: quoted, or unquoted up to `.exe`, as Windows reads it. */
function windowsRunCommandExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  const match = /^(.+?\.exe)(?:\s|$)/i.exec(trimmed);
  return match?.[1] ?? null;
}

/**
 * Keeps one entry, named `name`, on the running executable. An entry for an executable in the
 * same folder counts as this install's, so one an older name left behind is moved over, and
 * removed, rather than starting a file the installer deleted.
 */
export function planWindowsRunRepair(input: {
  readonly entries: ReadonlyArray<WindowsRunEntry>;
  readonly executablePath: string;
  readonly name: string;
}): WindowsRunRepair {
  const executable = normalizeWindowsPath(input.executablePath);
  const installDirectory = windowsDirname(input.executablePath);
  const ours = input.entries.filter((entry) => {
    const target = windowsRunCommandExecutable(entry.command);
    return target !== null && windowsDirname(target) === installDirectory;
  });
  const remove = ours.filter((entry) => entry.name !== input.name).map((entry) => entry.name);
  const own = ours.find((entry) => entry.name === input.name);
  const settled =
    own !== undefined &&
    remove.length === 0 &&
    normalizeWindowsPath(windowsRunCommandExecutable(own.command) ?? "") === executable;
  // Any active entry means the user starts this app at sign-in, whichever name it has.
  const enabled = ours.some((entry) => !entry.disabled);
  return { remove, write: ours.length === 0 || settled ? null : { enabled } };
}

const WINDOWS_RUN_ENTRIES_SCRIPT = `
$ErrorActionPreference = 'Stop'
$run = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
$approved = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run')
$entries = @()
if ($run) {
  foreach ($name in $run.GetValueNames()) {
    $state = if ($approved) { $approved.GetValue($name) } else { $null }
    $entries += [pscustomobject]@{
      name = $name
      command = [string]$run.GetValue($name)
      disabled = ($state -is [byte[]]) -and $state.Length -gt 0 -and (($state[0] -band 1) -eq 1)
    }
  }
}
$json = ConvertTo-Json -InputObject @($entries) -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

const decodeWindowsRunEntries = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ name: Schema.String, command: Schema.String, disabled: Schema.Boolean }),
    ),
  ),
);

export class DesktopLoginItem extends Context.Service<
  DesktopLoginItem,
  {
    readonly state: Effect.Effect<DesktopLoginItemState>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopLoginItemState, DesktopLoginItemError>;
    /** Moves the entry to this executable after an update renamed it, and drops older ones. */
    readonly repair: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLoginItem") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Login items register the running app; a development build would register Electron itself.
  const supported =
    environment.isPackaged &&
    (environment.platform === "darwin" || environment.platform === "win32");
  const windows = environment.platform === "win32";
  const executablePath = process.execPath;
  const name = environment.appUserModelId;

  const state: Effect.Effect<DesktopLoginItemState> = Effect.gen(function* () {
    if (!supported) return UNSUPPORTED;
    if (windows) {
      const settings = yield* electronApp.getLoginItemSettings({ path: executablePath, args: [] });
      return {
        supported,
        enabled: settings.executableWillLaunchAtLogin,
        requiresApproval: false,
      };
    }
    // `status` comes from SMAppService, which macOS 12 lacks; there `openAtLogin` is the answer.
    const { openAtLogin, status } = yield* electronApp.getLoginItemSettings();
    return {
      supported,
      enabled: openAtLogin || status === "enabled",
      requiresApproval: status === "requires-approval",
    };
  });

  const readWindowsRunEntries = runWindowsPowerShell(spawner, WINDOWS_RUN_ENTRIES_SCRIPT).pipe(
    Effect.flatMap((stdout) =>
      decodeWindowsRunEntries(Buffer.from(stdout.trim(), "base64").toString("utf8")),
    ),
  );

  const writeOwnEntry = (enabled: boolean) =>
    electronApp.setLoginItemSettings({
      openAtLogin: true,
      path: executablePath,
      args: [],
      enabled,
      name,
    });
  const removeEntry = (entryName: string) =>
    electronApp.setLoginItemSettings({ openAtLogin: false, name: entryName });

  const repair = Effect.gen(function* () {
    if (!supported || !windows) return;
    const entries = yield* readWindowsRunEntries;
    const plan = planWindowsRunRepair({ entries, executablePath, name });
    yield* Effect.forEach(plan.remove, removeEntry, { discard: true });
    if (plan.write !== null) yield* writeOwnEntry(plan.write.enabled);
    if (plan.remove.length > 0 || plan.write !== null)
      yield* Effect.logInfo("moved the start-at-login entry to this executable", {
        removed: plan.remove.length,
        enabled: plan.write?.enabled ?? null,
      });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("could not check the start-at-login entry", { cause: String(cause) }),
    ),
    Effect.withSpan("DesktopLoginItem.repair"),
  );

  const setEnabled = Effect.fn("DesktopLoginItem.setEnabled")(function* (enabled: boolean) {
    if (!supported)
      return yield* new DesktopLoginItemError({
        message: t("Open at login is not available in this build."),
      });
    if (windows) {
      // Clears entries older names left behind. Without the list, the switch still works through
      // Electron and reports what Windows will run; the next launch's repair retries the cleanup.
      const entries = yield* readWindowsRunEntries.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("could not list the apps that open at login", {
            cause: String(cause),
          }).pipe(Effect.as<ReadonlyArray<WindowsRunEntry>>([])),
        ),
      );
      const { remove } = planWindowsRunRepair({ entries, executablePath, name });
      yield* Effect.forEach(remove, removeEntry, { discard: true });
      yield* enabled ? writeOwnEntry(true) : removeEntry(name);
    } else {
      yield* electronApp.setLoginItemSettings({ openAtLogin: enabled });
    }
    return yield* state;
  });

  return DesktopLoginItem.of({ state, setEnabled, repair });
});

export const layer = Layer.effect(DesktopLoginItem, make);
