// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The launcher must survive unloadable server versions; use Node built-ins without Effect.
import { readRegularFileUtf8 } from "@t3tools/shared/regularFile";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { isProcessAlive } from "@t3tools/shared/processProbe";
import { acquireServiceSelectionLock } from "./cloud/serviceSelectionLock.ts";
import { RESTORE_OOMD_WATCH_SCRIPT } from "./cloud/userManagerOom.ts";
import { windowsSystem32Path } from "@t3tools/shared/windowsSystem";
import { isNoCopyOnWrite, markNoCopyOnWrite } from "./noCopyOnWrite.ts";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  parseLegacyServiceState,
  decodeServiceUnit,
  disabledServiceTask,
  encodeServiceTask,
  parseServiceState,
  serviceTaskIsDisabled,
  serviceUnitBaseDirOf,
  serviceUnitLogPathOf,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_LOCK_FILE,
  SERVICE_SERVING_LOCK_FILE,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
  SERVICE_UNIT_ENV,
  systemdUnitDirectoryOf,
} from "./cloud/serviceProtocol.ts";
import {
  legacyOwnerStartedBeforeRecord,
  legacyOwnerStartTimeCommand,
} from "./legacyServerOwner.ts";

const HANDOFF_DELAY_MS = 2_000;
/**
 * How long a trial may go without reporting migration progress or prepared. Migrations scale with
 * the database, and a missed window rolls the database back, so the next attempt starts over.
 */
const PREPARED_TIMEOUT_MS = 30 * 60_000;
const TERMINATE_GRACE_MS = 5_000;
// Keep SQLite startup and journaling from turning a full filesystem into a restart loop.
const MIN_SERVICE_START_FREE_BYTES = 64 * 1024 ** 2;
const DISK_SPACE_RETRY_MS = 30_000;
// A replacement started by a handoff waits up to two minutes for the stopping launcher.
const LOCK_RETRY_MS = 500;
const LOCK_ATTEMPTS = 240;
// Match contracts' SERVER_EXIT_CODE_STATE_DIR_OWNED without depending on Effect.
const STATE_DIR_OWNED_EXIT_CODE = 78;
const HANDOFF_PROBE_TIMEOUT_MS = 30_000;
/** A launcher started with this set only proves it can load the service state, then exits. */
const LAUNCHER_PROBE_ENV = "T3_SERVICE_LAUNCHER_PROBE";
const LAUNCHER_PROBE_OK = "service-launcher-probe-ok";
/**
 * Set on a launcher's delegate. To move the service to a newer launcher, the delegate exits with
 * HAND_BACK_EXIT_CODE and its parent starts that launcher, so a delegate never starts a launcher.
 */
const LAUNCHER_DELEGATE_ENV = "T3_SERVICE_LAUNCHER_DELEGATE";
const HAND_BACK_EXIT_CODE = 75;
/** Names a release whose launcher failed after taking over, for launchers to skip. */
const FAILED_LAUNCHER_FILE = ".failed-launcher";
const STATE_DIR_OWNER_POLL_MS = 30_000;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type LauncherOutcome = "stopped" | "handed-back";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  readonly process: NodeChildProcess.ChildProcess;
}

const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const executableName = process.platform === "win32" ? "t3.exe" : "t3";
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, executableName),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

/** The release this launcher process runs from; undefined outside an installed runtime (dev, tests). */
function runningLauncherVersion(baseDir: string, execPath: string): string | undefined {
  const versionDir = NodePath.dirname(execPath);
  const versionsDir = NodePath.join(baseDir, "runtime", "versions");
  if (NodePath.dirname(versionDir) !== versionsDir) return undefined;
  const version = NodePath.basename(versionDir);
  return isExactServiceVersion(version) ? version : undefined;
}

const runtimeSpawnArguments = (paths: ReturnType<typeof runtimePaths>) => ({
  command: paths.entryPath,
  args: ["serve"],
});

function isRegularFile(fd: number): boolean {
  try {
    return NodeFS.fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Node writes to a regular file synchronously, so a server whose output is the log file freezes
 * while the filesystem stalls one append. It gets a pipe instead, drained here without backpressure;
 * output beyond the cap is dropped while a write is stuck.
 */
function appendOutput(source: NodeJS.ReadableStream, fd: number): void {
  let pending: Array<Buffer> = [];
  let pendingBytes = 0;
  let writing = false;
  const flush = (): void => {
    writing = pending.length > 0;
    if (!writing) return;
    const chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    // Best effort, like the launcher's own diagnostics: a failed append drops that output.
    NodeFS.write(fd, chunk, flush);
  };
  source.on("data", (chunk: Buffer) => {
    if (pendingBytes + chunk.length > MAX_PENDING_OUTPUT_BYTES) return;
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (!writing) flush();
  });
}

/**
 * The unit or launch agent that `t3 service install` wrote. Its program names
 * the runtime that ran the install, and a remote update never replaces it, so
 * after a commit the launcher points it at the committed runtime. Otherwise the
 * next start lands on a runtime that nothing in the service state records.
 */
export interface ServiceUnit {
  readonly path: string;
  /** systemd and Task Scheduler keep a loaded copy; launchd re-reads the plist at bootstrap. */
  readonly reload: () => Promise<void>;
}

const SCHTASKS = () => windowsSystem32Path(process.env, "schtasks.exe");

const runSchtasks = (...args: ReadonlyArray<string>) =>
  NodeUtil.promisify(NodeChildProcess.execFile)(SCHTASKS(), args, {
    windowsHide: true,
    timeout: 30_000,
  });

/**
 * Registering replaces the task, so one the CLI disabled to keep the service stopped is
 * registered disabled. The caller holds the unit lease, as the CLI does to disable it.
 */
export async function registerServiceTask(
  unitPath: string,
  taskName: string,
  schtasks: (...args: ReadonlyArray<string>) => Promise<{ readonly stdout: string }> = runSchtasks,
): Promise<void> {
  const register = (xmlPath: string) => schtasks("/Create", "/XML", xmlPath, "/TN", taskName, "/F");
  const registered = await schtasks("/Query", "/TN", taskName, "/XML");
  if (!serviceTaskIsDisabled(registered.stdout)) {
    await register(unitPath);
    return;
  }
  const disabledPath = `${unitPath}.${process.pid}.disabled`;
  try {
    const unit = decodeServiceUnit(await NodeFSP.readFile(unitPath));
    await NodeFSP.writeFile(disabledPath, encodeServiceTask(disabledServiceTask(unit)));
    await register(disabledPath);
  } finally {
    await NodeFSP.rm(disabledPath, { force: true });
  }
}

// The manager's environment can differ from the one it gives services (environment.d).
async function readSystemdUnitDirectory(): Promise<string | undefined> {
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "busctl",
      [
        "--user",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "UnitPath",
      ],
      { timeout: 5_000 },
    );
    const { data } = JSON.parse(stdout) as { readonly data?: unknown };
    return Array.isArray(data) && data.every((entry) => typeof entry === "string")
      ? systemdUnitDirectoryOf(data)
      : undefined;
  } catch {
    return undefined;
  }
}

async function serviceUnitFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceUnit | undefined> {
  const unitName = env[SERVICE_UNIT_ENV]?.trim();
  if (!unitName) return undefined;
  if (unitName.endsWith(".xml")) {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) return undefined;
    const path = NodePath.win32.join(localAppData, "t3code", unitName);
    const taskName = serviceTaskName(env.USERDOMAIN ?? "", env.USERNAME ?? "");
    return { path, reload: () => registerServiceTask(path, taskName) };
  }
  const home = env.HOME?.trim();
  if (!home) return undefined;
  if (unitName.endsWith(".plist")) {
    return {
      path: NodePath.join(home, "Library", "LaunchAgents", unitName),
      reload: () => Promise.resolve(),
    };
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const unitDir =
    (await readSystemdUnitDirectory()) ??
    NodePath.join(
      xdgConfigHome && NodePath.isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : NodePath.join(home, ".config"),
      "systemd",
      "user",
    );
  return {
    path: NodePath.join(unitDir, unitName),
    reload: async () => {
      await new Promise<void>((resolve, reject) => {
        NodeChildProcess.spawn("systemctl", ["--user", "daemon-reload"], {
          stdio: "ignore",
          timeout: 30_000,
        })
          .once("error", reject)
          .once("exit", (code, signal) =>
            code === 0
              ? resolve()
              : reject(new Error(`systemctl --user daemon-reload exited with ${code ?? signal}`)),
          );
      });
      await new Promise<void>((resolve) => {
        NodeChildProcess.spawn("/bin/sh", ["-c", RESTORE_OOMD_WATCH_SCRIPT], {
          stdio: "ignore",
          timeout: 30_000,
        })
          .once("error", () => resolve())
          .once("exit", () => resolve());
      });
    },
  };
}

// systemd's ExecStart value, or the plist string or task argument before __service-launcher.
// Only the version segment changes, so quoted or escaped paths stay as rendered.
// The launch agent's PATH names a versions directory without the executable; leave it.
const SERVICE_UNIT_PROGRAMS = [
  /^(ExecStart=.*?[\\/]runtime[\\/]versions[\\/])([^\\/\s"]+)([\\/]t3)(?=["\s])/m,
  /(<string>[^<]*?[\\/]runtime[\\/]versions[\\/])([^\\/<]+)([\\/]t3<\/string>\s*<string>__service-launcher<\/string>)/,
  /(<Arguments>--headless "[^"<]*?[\\/]runtime[\\/]versions[\\/])([^\\/"<]+)([\\/]t3\.exe" "__service-launcher")/,
] as const;

/**
 * The unit contents with their program pointed at `version`'s runtime. A unit
 * already at that version or a newer one is returned unchanged: `t3 update`
 * may have repointed it to a later version while this commit was in flight.
 */
function repointServiceUnit(contents: string, version: string): string {
  for (const program of SERVICE_UNIT_PROGRAMS) {
    const match = program.exec(contents);
    if (match === null) continue;
    const [, prefix = "", current = "", suffix = ""] = match;
    if (isExactServiceVersion(current) && compareExactServiceVersions(current, version) >= 0) {
      return contents;
    }
    return contents.replace(program, () => `${prefix}${version}${suffix}`);
  }
  return contents;
}

const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;
const SERVICE_LOG_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * The service manager holds the log open for appending, so it is copied aside and emptied in
 * place rather than renamed. The copy is best effort: on a full disk the truncate frees space.
 */
async function boundServiceLog(logPath: string): Promise<void> {
  const size = await NodeFSP.stat(logPath).then(
    (stats) => stats.size,
    () => 0,
  );
  if (size <= SERVICE_LOG_MAX_BYTES) return;
  const archivePath = `${logPath}.1`;
  const pendingArchivePath = `${archivePath}.tmp`;
  await NodeFSP.copyFile(logPath, pendingArchivePath)
    .then(() => NodeFSP.rename(pendingArchivePath, archivePath))
    .catch(() => NodeFSP.rm(pendingArchivePath, { force: true }).catch(() => undefined));
  await NodeFSP.truncate(logPath, 0).catch(() => undefined);
}

async function serviceLogPath(
  options: LauncherOptions,
  serviceUnit: ServiceUnit | undefined,
): Promise<string | undefined> {
  if (options.logFile !== undefined) return options.logFile;
  if (serviceUnit === undefined) return undefined;
  const contents = await NodeFSP.readFile(serviceUnit.path)
    .then(decodeServiceUnit)
    .catch(() => undefined);
  return contents === undefined ? undefined : serviceUnitLogPathOf(contents);
}

const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const RESTORE_MARKER = ".restore-pending";

const databaseBackupDir = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", "db-backup", updateId);

const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

const MANAGED_SERVICE_ENV_NAMES = new Set([
  "PATH",
  "T3CODE_HOME",
  "T3_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
  LAUNCHER_DELEGATE_ENV,
]);

export async function readServiceEnvironment(
  baseDir: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  let contents: string;
  try {
    contents = await NodeFSP.readFile(NodePath.join(baseDir, SERVICE_ENV_FILE), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return environment;
    throw cause;
  }
  for (const [name, value] of Object.entries(NodeUtil.parseEnv(contents))) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !MANAGED_SERVICE_ENV_NAMES.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

// Opened read-write: Windows refuses to flush a handle without write access.
async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Fsync makes renames durable; Windows returns EPERM and NTFS journals them itself.
async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

function runCp(args: ReadonlyArray<string>, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile("cp", args, { signal }, (error) => resolve(error === null));
  });
}

// macOS fs.copyFile clone flags fall back to full copies.
async function copyDatabaseFile(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  // cp -c replaces files and breaks hard links; copy into hard-linked destinations instead.
  const hardLinked =
    platform === "darwin" &&
    ((await NodeFSP.stat(destination).catch(() => undefined))?.nlink ?? 1) > 1;
  const args =
    platform === "darwin" && !hardLinked
      ? ["-c", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", source, destination]
        : undefined;
  if (args !== undefined && (await runCp(args, signal))) return;
  signal?.throwIfAborted();
  await NodeFSP.copyFile(source, destination);
}

const GIB = 1024 ** 3;
// Pinned and cloned snapshots still need headroom for the trial's writes and migrations to land.
const CLONED_BACKUP_MIN_HEADROOM_BYTES = GIB;
const CLONED_BACKUP_HEADROOM_FRACTION = 0.1;

async function statDatabaseFiles(dbPath: string): Promise<ReadonlyArray<NodeFS.Stats>> {
  const stats: Array<NodeFS.Stats> = [];
  for (const suffix of DB_FILE_SUFFIXES) {
    const stat = await NodeFSP.stat(`${dbPath}${suffix}`).catch((cause: unknown) => {
      if (suffix !== "" && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (stat !== undefined) stats.push(stat);
  }
  return stats;
}

// cp -c silently copies across volumes; require one device matching the APFS system volume's filesystem type.
async function backupCanClone(dbPath: string, backupRoot: string): Promise<boolean> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  if (platform === "darwin") {
    const [backupDirectory, backupFs, systemFs] = await Promise.all([
      NodeFSP.stat(backupRoot),
      NodeFSP.statfs(backupRoot),
      NodeFSP.statfs("/"),
    ]);
    if (backupFs.type !== systemFs.type) return false;
    return (await statDatabaseFiles(dbPath)).every(
      (source) => source.dev === backupDirectory.dev && source.nlink === 1,
    );
  }
  if (platform !== "linux") return false;
  const probe = NodePath.join(backupRoot, `.clone-probe-${NodeCrypto.randomUUID()}`);
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      if (!(await runCp(["--reflink=always", source, `${probe}${suffix}`]))) return false;
    }
    return true;
  } finally {
    for (const suffix of DB_FILE_SUFFIXES) {
      await NodeFSP.rm(`${probe}${suffix}`, { force: true }).catch(() => undefined);
    }
  }
}

export interface BackupSpaceProbe {
  readonly readFreeBytes: (directory: string) => Promise<number>;
  /** True when the snapshot costs headroom rather than a full copy: a WAL pin or a reflink clone. */
  readonly avoidsFullCopy: (dbPath: string, backupRoot: string) => Promise<boolean>;
}

const filesystemBackupSpaceProbe: BackupSpaceProbe = {
  readFreeBytes: async (directory) => {
    const stats = await NodeFSP.statfs(directory);
    return stats.bavail * stats.bsize;
  },
  avoidsFullCopy: async (dbPath, backupRoot) =>
    (await isWalDatabase(dbPath)) || (await backupCanClone(dbPath, backupRoot)),
};

// A killed launcher skips the backup's cleanup, and retries only clear their own update's copy.
// Update requests are refused while one is pending, so no staging directory is still in use here.
async function removeAbandonedBackupCopies(backupRoot: string): Promise<void> {
  for (const entry of await NodeFSP.readdir(backupRoot)) {
    if (!entry.endsWith(".staging")) continue;
    await NodeFSP.rm(NodePath.join(backupRoot, entry), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Check before stopping the server so full disks refuse updates without an outage. */
export async function databaseBackupBlocker(
  baseDir: string,
  dbPath: string,
  probe: Partial<BackupSpaceProbe> = {},
): Promise<string | undefined> {
  const { readFreeBytes, avoidsFullCopy } = { ...filesystemBackupSpaceProbe, ...probe };
  const backupRoot = NodePath.join(baseDir, "runtime", "db-backup");
  await NodeFSP.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  if (await isNoCopyOnWrite(dbPath)) await markNoCopyOnWrite(backupRoot);
  await removeAbandonedBackupCopies(backupRoot);
  const [files, free] = await Promise.all([statDatabaseFiles(dbPath), readFreeBytes(backupRoot)]);
  const size = files.reduce((total, file) => total + file.size, 0);
  const fullCopyBytes = size * 1.05;
  if (free >= fullCopyBytes) return undefined;
  const clonedBytes = Math.max(
    CLONED_BACKUP_MIN_HEADROOM_BYTES,
    size * CLONED_BACKUP_HEADROOM_FRACTION,
  );
  const needed = (await avoidsFullCopy(dbPath, backupRoot)) ? clonedBytes : fullCopyBytes;
  if (free >= needed) return undefined;
  const gb = (bytes: number) => (bytes / GIB).toFixed(1);
  return `Not enough free disk space to back up the database before updating: ${gb(needed)} GB needed, ${gb(free)} GB free. Free up disk space and try again. The server was not stopped.`;
}

const WAL_PIN_RECORD = "wal-pin.json";
const WAL_PIN_START_TIMEOUT_MS = 60_000;
const WAL_PIN_RELEASE_TIMEOUT_MS = 5_000;

// A checkpoint cannot copy WAL frames past an open reader's snapshot into the main file, so this
// read transaction keeps the trial's writes in the WAL. It is a separate process because closing a
// SQLite connection checkpoints: rolling back kills it, and a killed process writes nothing.
const WAL_PIN_SOURCE = `
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
const dbPath = process.argv[1];
const say = (line) => process.stdout.write(line + "\\n");
const db = new DatabaseSync(dbPath);
if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") { say("unpinnable:not-wal"); process.exit(0); }
if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy !== 0) { say("unpinnable:busy"); process.exit(0); }
db.exec("BEGIN");
db.prepare("SELECT count(*) FROM sqlite_master").get();
const { size, mtimeMs } = statSync(dbPath);
say("pinned:" + JSON.stringify({ size, mtimeMs }));
process.stdin.on("data", (chunk) => { if (String(chunk).includes("release")) { db.close(); process.exit(0); } });
process.stdin.on("end", () => process.exit(0));
`;

interface WalPinRecord {
  readonly size: number;
  readonly mtimeMs: number;
}

const dbPins = new Map<string, NodeChildProcess.ChildProcess>();

async function isWalDatabase(dbPath: string): Promise<boolean> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(dbPath, "r");
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    // Bytes 18 and 19 of the SQLite header are 2 when the file is in WAL mode.
    return bytesRead === 20 && header[18] === 2 && header[19] === 2;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function startDatabasePin(updateId: string, dbPath: string): Promise<WalPinRecord | undefined> {
  return new Promise((resolve) => {
    const helper = NodeChildProcess.spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", WAL_PIN_SOURCE, dbPath],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let settled = false;
    let output = "";
    const settle = (record: WalPinRecord | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (record === undefined) helper.kill("SIGKILL");
      else dbPins.set(updateId, helper);
      resolve(record);
    };
    const timer = setTimeout(() => settle(undefined), WAL_PIN_START_TIMEOUT_MS);
    helper.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const lineEnd = output.indexOf("\n");
      if (lineEnd === -1) return;
      const line = output.slice(0, lineEnd);
      if (!line.startsWith("pinned:")) return settle(undefined);
      try {
        settle(JSON.parse(line.slice("pinned:".length)) as WalPinRecord);
      } catch {
        settle(undefined);
      }
    });
    helper.once("error", () => settle(undefined));
    helper.once("exit", () => settle(undefined));
  });
}

const pinHasExited = (helper: NodeChildProcess.ChildProcess) =>
  helper.exitCode !== null || helper.signalCode !== null;

// Keeps whatever the trial wrote: the update committed, or nobody may roll the database back.
async function releaseDatabasePin(updateId: string): Promise<void> {
  const helper = dbPins.get(updateId);
  if (helper === undefined) return;
  dbPins.delete(updateId);
  if (pinHasExited(helper)) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      helper.kill("SIGKILL");
      resolve();
    }, WAL_PIN_RELEASE_TIMEOUT_MS);
    helper.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    helper.stdin?.end("release\n");
  });
}

async function killDatabasePin(updateId: string): Promise<void> {
  const helper = dbPins.get(updateId);
  if (helper === undefined) return;
  dbPins.delete(updateId);
  if (pinHasExited(helper)) return;
  await new Promise<void>((resolve) => {
    helper.once("exit", () => resolve());
    helper.kill("SIGKILL");
  });
}

async function readWalPinRecord(backupDir: string): Promise<WalPinRecord | undefined> {
  try {
    return JSON.parse(
      await NodeFSP.readFile(NodePath.join(backupDir, WAL_PIN_RECORD), "utf8"),
    ) as WalPinRecord;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

// The pin kept the main file as the update found it, so a changed size or mtime means something
// wrote to it and there is no safe database to boot.
async function undoPinnedTrial(dbPath: string, record: WalPinRecord): Promise<void> {
  const target = await restoreTarget(dbPath);
  const stat = await NodeFSP.stat(target);
  if (stat.size !== record.size || stat.mtimeMs !== record.mtimeMs) {
    throw new Error("The database file changed during the update trial; it cannot be rolled back.");
  }
  const directories = new Set<string>();
  for (const base of new Set([dbPath, target])) {
    for (const suffix of ["-wal", "-shm"] as const) {
      await NodeFSP.rm(`${base}${suffix}`, { force: true });
    }
    directories.add(NodePath.dirname(base));
  }
  for (const directory of directories) await syncDirectory(directory);
}

// Preserve completed backups; restarted trials may already have changed the live database.
// A target that applies no migration leaves the schema as it was, so there is nothing to undo.
// A WAL database is pinned, not copied: the trial's writes stay in the WAL, which rolling back
// deletes, so the snapshot costs the WAL's size and not the database's.
async function backupDatabaseOnce(
  baseDir: string,
  pending: PendingServiceUpdate,
  signal: AbortSignal,
): Promise<void> {
  if (pending.migratesDatabase === false) return;
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) {
    const record = await readWalPinRecord(backupDir);
    if (record === undefined || dbPins.has(pending.id)) return;
    // The launcher restarted mid-trial and lost its pin: undo that trial, then pin again.
    await undoPinnedTrial(pending.dbPath, record);
    await NodeFSP.rm(backupDir, { recursive: true, force: true });
  }

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const pin = (await isWalDatabase(pending.dbPath))
      ? await startDatabasePin(pending.id, pending.dbPath)
      : undefined;
    if (pin === undefined) {
      for (const suffix of DB_FILE_SUFFIXES) {
        signal.throwIfAborted();
        const source = `${pending.dbPath}${suffix}`;
        if (suffix !== "" && !(await pathExists(source))) continue;
        const destination = databaseBackupFile(stagingDir, suffix);
        await copyDatabaseFile(source, destination, signal);
        await syncFile(destination);
      }
    } else {
      const recordPath = NodePath.join(stagingDir, WAL_PIN_RECORD);
      await NodeFSP.writeFile(recordPath, JSON.stringify(pin), { mode: 0o600 });
      await syncFile(recordPath);
    }
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await releaseDatabasePin(pending.id).catch(() => undefined);
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

const restoreMarkerPath = (baseDir: string, updateId: string) =>
  NodePath.join(databaseBackupDir(baseDir, updateId), RESTORE_MARKER);

const databaseRestorePending = (baseDir: string, pending: PendingServiceUpdate) =>
  pathExists(restoreMarkerPath(baseDir, pending.id));

// Mark before live writes so recovery cannot boot a partial restore.
async function markDatabaseRestorePending(backupDir: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, RESTORE_MARKER);
  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(backupDir);
  }
}

// Resolve symlink targets even if a crashed cp -c left the final target missing.
async function restoreTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    try {
      return await NodeFSP.realpath(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const link = await NodeFSP.readlink(current).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return undefined;
      throw cause;
    });
    if (link === undefined) return current;
    // Do not normalize .. before following directory symlinks; match filesystem resolution.
    current = NodePath.isAbsolute(link)
      ? link
      : `${await NodeFSP.realpath(NodePath.dirname(current))}${NodePath.sep}${link}`;
  }
  throw new Error(`Too many symbolic links resolving ${path}.`);
}

async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return;

  await markDatabaseRestorePending(backupDir);
  const pinRecord = await readWalPinRecord(backupDir);
  if (pinRecord !== undefined) {
    await killDatabasePin(pending.id);
    await undoPinnedTrial(pending.dbPath, pinRecord);
    return;
  }
  const directories = new Set([NodePath.dirname(pending.dbPath)]);
  // SQLite keeps -wal and -shm beside the resolved database file, not beside a symlink to it.
  const mainTarget = await restoreTarget(pending.dbPath);
  for (const suffix of DB_FILE_SUFFIXES) {
    const livePath = suffix === "" ? pending.dbPath : `${mainTarget}${suffix}`;
    if (livePath !== `${pending.dbPath}${suffix}`) {
      await NodeFSP.rm(`${pending.dbPath}${suffix}`, { force: true });
    }
    const source = databaseBackupFile(backupDir, suffix);
    if (await pathExists(source)) {
      // Restore into the symlink target; cloning would replace the link.
      const target = await restoreTarget(livePath);
      await copyDatabaseFile(source, target);
      await syncFile(target);
      directories.add(NodePath.dirname(target));
    } else {
      await NodeFSP.rm(livePath, { force: true });
    }
  }
  for (const directory of directories) await syncDirectory(directory);
}

async function discardDatabaseBackup(baseDir: string, updateId: string): Promise<void> {
  await releaseDatabasePin(updateId);
  const backupDir = databaseBackupDir(baseDir, updateId);
  if (!(await pathExists(backupDir))) return;
  await NodeFSP.rm(backupDir, { recursive: true, force: true });
  await syncDirectory(NodePath.dirname(backupDir));
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents) ?? adoptLegacyServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

// An older coordinator can write protocol 2 beside a newer runtime. Adopt
// only its install record, in memory: rewriting it outside the selection lock
// could replace state a concurrent install wrote after this read.
function adoptLegacyServiceState(contents: string): ServiceState | undefined {
  const legacy = parseLegacyServiceState(contents);
  return legacy && { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: legacy.activeVersion };
}

export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  await replaceFileDurably(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function replaceFileDurably(filePath: string, contents: string | Uint8Array): Promise<void> {
  const directory = NodePath.dirname(filePath);
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      readRegularFileUtf8(paths.sentinelPath),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}

function terminalUpdate<S extends TerminalStatus>(input: {
  readonly pending: PendingServiceUpdate;
  readonly status: S;
  readonly reason?: string;
}): Exclude<ServiceUpdateRecord, PendingServiceUpdate> & { readonly status: S } {
  return {
    id: input.pending.id,
    fromVersion: input.pending.fromVersion,
    targetVersion: input.pending.targetVersion,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

/** The target launcher must load this state before the service is handed to it. */
function probeLauncher(entryPath: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      entryPath,
      ["__service-launcher"],
      {
        env: { ...environment, [LAUNCHER_PROBE_ENV]: "1" },
        timeout: HANDOFF_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout) => resolve(error === null && stdout.includes(LAUNCHER_PROBE_OK)),
    );
  });
}

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function terminateChild(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals,
  overIpc: boolean,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (overIpc) {
    await sendMessage(child, { type: "stop" }).catch(() => child.kill(signal));
  } else {
    child.kill(signal);
  }
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}

/** Task Scheduler names are machine-wide, so each Windows account runs its own task. */
export const serviceTaskName = (domain: string, userName: string) => `t3code-${domain}-${userName}`;

export const serviceLauncherLockPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_LAUNCHER_LOCK_FILE);

// An exclusive SQLite transaction, like the server's owner lock: the OS drops it when the holder dies.
async function tryAcquireSqliteLock(
  lockPath: string,
  busyTimeoutMs = 0,
): Promise<{ readonly close: () => void } | undefined> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(lockPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; BEGIN EXCLUSIVE;`);
    return db;
  } catch (cause) {
    db.close();
    if (cause instanceof Error && "errcode" in cause && cause.errcode === 5) return undefined;
    throw cause;
  }
}

export async function serviceLauncherIsRunning(lockPath: string): Promise<boolean> {
  if (!NodeFS.existsSync(lockPath)) return false;
  const lock = await tryAcquireSqliteLock(lockPath);
  lock?.close();
  return lock === undefined;
}

const servingLockPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_SERVING_LOCK_FILE);

/** Whether a launcher has, or is about to start, a server for this home. An idle one does not. */
export const serviceLauncherIsServing = (baseDir: string): Promise<boolean> =>
  serviceLauncherIsRunning(servingLockPath(baseDir)).catch(() => false);

/** Resolves once no launcher holds the lock; the caller bounds the wait through `signal`. */
export async function waitForServiceLauncherExit(
  lockPath: string,
  signal: AbortSignal,
): Promise<void> {
  while (await serviceLauncherIsRunning(lockPath)) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Mirror acquireServerOwnership: the lock, then a live pre-lock server-runtime.json owner;
// leave other failures for server startup to report.
export async function stateDirOwned(baseDir: string): Promise<boolean> {
  const stateDir = NodePath.join(baseDir, "userdata");
  const lock = await tryAcquireSqliteLock(NodePath.join(stateDir, "server-owner.sqlite")).catch(
    () => null,
  );
  if (lock === null) return false;
  if (lock === undefined) return true;
  lock.close();
  let record: unknown;
  try {
    record = JSON.parse(
      await NodeFSP.readFile(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
    );
  } catch {
    return false;
  }
  if (typeof record !== "object" || record === null || "ownerId" in record) return false;
  const pid = "pid" in record ? record.pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (!isProcessAlive(pid)) return false;
  const recordedAt = Date.parse(
    "startedAt" in record && typeof record.startedAt === "string" ? record.startedAt : "",
  );
  if (!Number.isFinite(recordedAt)) return true;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform, process.env);
  const output = await new Promise<string | undefined>((resolve) =>
    NodeChildProcess.execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout: 2_000, maxBuffer: 16_384 },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    ),
  );
  return legacyOwnerStartedBeforeRecord(output, recordedAt, platform);
}

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
const restartPendingPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
const failedLauncherPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", FAILED_LAUNCHER_FILE);
const readFailedLauncher = (baseDir: string) =>
  NodeFSP.readFile(failedLauncherPath(baseDir), "utf8").then(
    (version) => version.trim(),
    () => undefined,
  );

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  readonly #stopSignal = new AbortController();
  #stopping = false;
  #done = false;
  #delegate: NodeChildProcess.ChildProcess | null = null;
  readonly #launcherVersion: string | undefined;
  readonly #completion = Promise.withResolvers<LauncherOutcome>();
  readonly #backupSpaceProbe: Partial<BackupSpaceProbe> | undefined;
  readonly #serviceUnit: ServiceUnit | undefined;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #handsBack: boolean;
  readonly #stateDirOwnerPollMs: number;
  #stateDirFreeProbes = 0;
  readonly #output: number | undefined;
  readonly #lockPath: string | undefined;
  #servingLock: { readonly close: () => void } | undefined;
  readonly #stopChildOverIpc: boolean;

  constructor(
    baseDir: string,
    state: ServiceState,
    options: {
      readonly backupSpaceProbe?: Partial<BackupSpaceProbe>;
      readonly serviceUnit?: ServiceUnit;
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly launcherVersion?: string | undefined;
      readonly stateDirOwnerPollMs?: number;
      /** Launcher and server output, for managers that cannot redirect it. */
      readonly output?: number;
      /** Makes this the only launcher for its home; a replacement waits for the one stopping. */
      readonly lockPath?: string;
      /** Windows `kill()` is TerminateProcess, which skips the server's shutdown finalizers. */
      readonly stopChildOverIpc?: boolean;
    } = {},
  ) {
    this.#launcherVersion =
      "launcherVersion" in options
        ? options.launcherVersion
        : runningLauncherVersion(baseDir, process.execPath);
    this.#baseDir = baseDir;
    this.#stateDirOwnerPollMs = options.stateDirOwnerPollMs ?? STATE_DIR_OWNER_POLL_MS;
    this.#backupSpaceProbe = options.backupSpaceProbe;
    const { [LAUNCHER_DELEGATE_ENV]: delegateMarker, ...environment } =
      options.environment ?? process.env;
    this.#handsBack = delegateMarker === "1";
    this.#serviceUnit = options.serviceUnit;
    this.#environment = environment;
    this.#output = options.output;
    this.#lockPath = options.lockPath;
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
    this.#stopChildOverIpc = options.stopChildOverIpc ?? process.platform === "win32";
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
  }

  async run(): Promise<LauncherOutcome> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    try {
      const lock =
        this.#lockPath === undefined ? undefined : await this.#acquireLock(this.#lockPath);
      try {
        // The launcher that held the lock may have moved the state since main read it.
        if (lock !== undefined) this.#state = await readServiceState(this.#statePath);
        // A stop that arrived before this point leaves nothing to start or recover.
        if (!this.#stopRequested) this.#enqueue(() => this.#recover());
        return await this.#completion.promise;
      } finally {
        if (lock !== undefined) {
          // Releasing the lock says this launcher is done with the home.
          await this.#transitions.catch(() => undefined);
          lock.close();
        }
      }
    } finally {
      this.#releaseServing();
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  async #acquireLock(lockPath: string): Promise<{ readonly close: () => void } | undefined> {
    for (let attempt = 1; !this.#stopRequested; attempt++) {
      const lock = await tryAcquireSqliteLock(lockPath);
      if (lock !== undefined) return lock;
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error("Another T3.CodeShip service launcher still runs for this T3 home.");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    return undefined;
  }

  // Advisory: without it an SSH launch may start its own server, as it does beside no service.
  async #claimServing(): Promise<void> {
    // An SSH launch probes this lock for a moment; wait out that probe.
    this.#servingLock ??= await tryAcquireSqliteLock(servingLockPath(this.#baseDir), 250).catch(
      () => undefined,
    );
  }

  #releaseServing(): void {
    this.#servingLock?.close();
    this.#servingLock = undefined;
  }

  #terminate(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    return terminateChild(child, signal, this.#stopChildOverIpc);
  }

  // Diagnostics are best-effort: a full log filesystem must not stop the launcher waiting for space.
  #log(line: string): void {
    try {
      if (this.#output === undefined) process.stderr.write(line);
      else NodeFS.writeSync(this.#output, line);
    } catch {}
  }

  #enqueue(transition: () => Promise<void>): void {
    this.#transitions = this.#transitions
      .then(transition, transition)
      .catch((cause: unknown) =>
        this.#fatal(cause instanceof Error ? cause : new Error(String(cause))),
      );
  }

  async #fatal(error: Error): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#stopping = true;
    this.#clearTimer();
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) await this.#terminate(child);
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    // Write synchronously on signal receipt; a terminating child needs the marker in its finalizer.
    try {
      NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
    } catch {}
    if (this.#stopRequested || this.#stopping) {
      await this.#completion.promise.catch(() => undefined);
      return;
    }
    this.#stopRequested = true;
    this.#stopSignal.abort();
    const delegate = this.#delegate;
    if (delegate !== null) {
      // The queue is blocked on the delegate, which owns the service and takes the signal.
      await terminateChild(delegate, signal, false);
      await this.#completion.promise.catch(() => undefined);
      return;
    }
    this.#clearTimer();
    this.#enqueue(async () => {
      // Let in-progress updates start replacements first; replacements observe the marker and own pre-activation tunnel cleanup.
      this.#stopping = true;
      // An exit-78 transition queued before this one may have started the owner poll.
      this.#clearTimer();
      const child = this.#child?.process;
      this.#child = null;
      if (child !== undefined) await this.#terminate(child, signal);
      this.#done = true;
      this.#completion.resolve("stopped");
    });
    await this.#completion.promise.catch(() => undefined);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #serviceStartDiskSpaceBlocker(): Promise<string | undefined> {
    const databasePath =
      this.#state.update?.status === "pending"
        ? this.#state.update.dbPath
        : NodePath.join(this.#baseDir, "userdata", "statev2.sqlite");
    const resolvedDatabasePath = await restoreTarget(databasePath).catch(() => databasePath);
    const freeBytes = async (directory: string): Promise<number> => {
      try {
        return await filesystemBackupSpaceProbe.readFreeBytes(directory);
      } catch (cause) {
        const parent = NodePath.dirname(directory);
        if ((cause as NodeJS.ErrnoException).code === "ENOENT" && parent !== directory) {
          return freeBytes(parent);
        }
        return Number.POSITIVE_INFINITY;
      }
    };
    const available = await Promise.all([
      freeBytes(this.#baseDir),
      freeBytes(NodePath.dirname(resolvedDatabasePath)),
    ]);
    const free = Math.min(...available);
    return free < MIN_SERVICE_START_FREE_BYTES
      ? `T3.CodeShip needs at least ${MIN_SERVICE_START_FREE_BYTES} bytes free before starting the server; ${free} bytes available.`
      : undefined;
  }

  async #deferForDiskSpace(retry: () => Promise<void>): Promise<boolean> {
    const reason = await this.#serviceStartDiskSpaceBlocker();
    if (reason === undefined) return false;
    // A stop during the probe must not arm a retry that outlives it.
    if (this.#stopRequested) return true;
    this.#clearTimer();
    this.#releaseServing();
    this.#log(`[service-launcher] ${reason} Waiting for free space before retrying.\n`);
    this.#timer = setInterval(
      () =>
        this.#enqueue(async () => {
          if (this.#child !== null || this.#stopping) return;
          if ((await this.#serviceStartDiskSpaceBlocker()) !== undefined) return;
          this.#clearTimer();
          await this.#claimServing();
          await retry();
        }),
      DISK_SPACE_RETRY_MS,
    );
    return true;
  }

  async #selectState(next: ServiceState): Promise<void> {
    const release = await acquireServiceSelectionLock(this.#statePath);
    try {
      const selected = await readServiceState(this.#statePath);
      // Local installs replace the selection and clear its update record. An old
      // launcher must not restore its own selection when asked to update again.
      if (
        selected.activeVersion !== this.#state.activeVersion ||
        selected.update?.id !== this.#state.update?.id ||
        selected.update?.status !== this.#state.update?.status
      ) {
        throw new Error("Service selection changed. Restart the service before updating.");
      }
      await writeServiceState(this.#statePath, next);
      this.#state = next;
    } finally {
      release();
    }
  }

  async #recover(): Promise<void> {
    await this.#claimServing();
    // Clear old stop markers to preserve future tunnels; clear restart-pending only for the awaited version to avoid CLI races.
    await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
    const restartPending = restartPendingPath(this.#baseDir);
    try {
      const release = await acquireServiceSelectionLock(this.#statePath);
      try {
        const selected = await readServiceState(this.#statePath);
        const awaitedVersion = await NodeFSP.readFile(restartPending, "utf8").catch(
          () => undefined,
        );
        const awaited = awaitedVersion?.trim();
        if (
          selected.activeVersion === this.#state.activeVersion &&
          selected.update?.id === this.#state.update?.id &&
          selected.update?.status === this.#state.update?.status &&
          awaited !== undefined &&
          isExactServiceVersion(awaited) &&
          compareExactServiceVersions(awaited, this.#state.activeVersion) <= 0
        ) {
          await NodeFSP.rm(restartPending, { force: true });
        }
      } finally {
        release();
      }
    } catch (error) {
      process.stderr.write(
        `[service-launcher] Could not clear ${restartPending}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (await this.#handOff()) return;
    await this.#resume();
  }

  /** Runs the service from the recorded state, whose update may still be pending after a restart. */
  async #resume(): Promise<void> {
    const update = this.#state.update;
    if (update?.status !== "pending") {
      if (update !== undefined) {
        await discardDatabaseBackup(this.#baseDir, update.id).catch(() => undefined);
      }
      try {
        await this.#startChild(this.#state.activeVersion, "active", update);
      } finally {
        if (update !== undefined) await this.#repointServiceUnit(this.#state.activeVersion);
      }
      return;
    }
    if (await databaseRestorePending(this.#baseDir, update)) {
      await this.#returnToPrevious(update, "failed", "rollback-interrupted");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
      await this.#returnToPrevious(update, "failed", "target-runtime-missing");
      return;
    }
    await this.#startTrial(update);
  }

  async #startTrial(pending: PendingServiceUpdate): Promise<void> {
    if (await this.#deferForDiskSpace(() => this.#startTrial(pending))) return;
    try {
      await backupDatabaseOnce(this.#baseDir, pending, this.#stopSignal.signal);
    } catch {
      // A stop aborts the copy and leaves the update pending for the next start.
      if (this.#stopRequested) return;
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    if (this.#stopRequested) return;
    try {
      await this.#startChild(pending.targetVersion, "trial", pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "candidate-start-failed");
    }
  }

  async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
    if (this.#stopping) return;
    if (
      await this.#deferForDiskSpace(() =>
        role === "trial" && update?.status === "pending"
          ? this.#startTrial(update)
          : this.#startChild(version, role, update),
      )
    )
      return;
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
    }
    if (this.#stopping) return;
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: version,
      ...(update === undefined ? {} : { update }),
    };
    const spawnArguments = runtimeSpawnArguments(paths);
    const appendStdout = this.#output === undefined && isRegularFile(1);
    const appendStderr = this.#output === undefined && isRegularFile(2);
    const child = NodeChildProcess.spawn(spawnArguments.command, spawnArguments.args, {
      env: { ...this.#environment, [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) },
      stdio:
        this.#output === undefined
          ? ["inherit", appendStdout ? "pipe" : "inherit", appendStderr ? "pipe" : "inherit", "ipc"]
          : ["ignore", this.#output, this.#output, "ipc"],
    });
    if (child.stdout !== null) appendOutput(child.stdout, 1);
    if (child.stderr !== null) appendOutput(child.stderr, 2);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.on("error", (error) => this.#enqueue(() => Promise.reject(error)));
        resolve();
      });
    });
    if (this.#stopping) {
      await this.#terminate(child);
      return;
    }

    const managed: ManagedChild = {
      version,
      role,
      process: child,
    };
    this.#child = managed;
    child.on("message", (value) => {
      const message = decodeServiceLauncherChildMessage(value);
      if (message !== undefined) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) =>
      this.#enqueue(() => this.#handleExit(managed, code, signal)),
    );

    if (role === "trial") this.#armPreparedTimeout(managed);
  }

  #armPreparedTimeout(child: ManagedChild): void {
    // A deadline that fires while a progress report waits in the queue must not outlive its re-arm.
    const timer = setTimeout(
      () =>
        this.#enqueue(async () => {
          if (this.#timer === timer) await this.#handlePreparedTimeout(child);
        }),
      PREPARED_TIMEOUT_MS,
    );
    this.#timer = timer;
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    switch (message.type) {
      case "request-update":
        await this.#handleUpdateRequest(child, message);
        return;
      case "preparing":
        this.#handlePreparing(child, message.updateId);
        return;
      case "prepared":
        await this.#handlePrepared(child, message.updateId);
        return;
    }
  }

  #handlePreparing(child: ManagedChild, updateId: string): void {
    const pending = this.#state.update;
    if (child.role !== "trial" || pending?.status !== "pending" || pending.id !== updateId) return;
    this.#clearTimer();
    this.#armPreparedTimeout(child);
  }

  async #handleUpdateRequest(
    child: ManagedChild,
    message: Extract<ServiceLauncherChildMessage, { readonly type: "request-update" }>,
  ): Promise<void> {
    const reject = (reason: string) =>
      sendMessage(child.process, { type: "update-rejected", reason });
    if (child.role !== "active") {
      await reject("Only the active server can request an update.");
      return;
    }
    if (child.version !== this.#state.activeVersion) {
      await reject("The requesting server is not the selected active version.");
      return;
    }
    if (this.#state.update?.status === "pending") {
      await reject("Another server update is already pending.");
      return;
    }
    if (!isExactServiceVersion(message.targetVersion)) {
      await reject("The requested target is not an exact version.");
      return;
    }
    if (compareExactServiceVersions(message.targetVersion, child.version) <= 0) {
      await reject("Remote updates must select a newer server version.");
      return;
    }
    if (!NodePath.isAbsolute(message.dbPath)) {
      await reject("The requested database path is not absolute.");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, message.targetVersion))) {
      await reject("The requested target runtime is missing or incomplete.");
      return;
    }
    const snapshotsDatabase = message.migratesDatabase !== false;
    // Failed checks must refuse updates rather than stop the server with unknown backup capacity.
    const backupBlocker = snapshotsDatabase
      ? await databaseBackupBlocker(this.#baseDir, message.dbPath, this.#backupSpaceProbe).catch(
          (error: unknown) =>
            `Could not check that the database backup fits before updating: ${error instanceof Error ? error.message : String(error)}. The server was not stopped.`,
        )
      : undefined;
    if (!child.process.connected) return;
    if (backupBlocker !== undefined) {
      await reject(backupBlocker);
      return;
    }

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: child.version,
      targetVersion: message.targetVersion,
      dbPath: message.dbPath,
      ...(snapshotsDatabase ? {} : { migratesDatabase: false }),
      status: "pending",
    };
    const next: ServiceState = { ...this.#state, update: pending };
    try {
      await this.#selectState(next);
    } catch (error) {
      await reject(error instanceof Error ? error.message : String(error));
      return;
    }
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "active" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    this.#child = null;
    await this.#terminate(child.process);
    await this.#startTrial(pending);
  }

  async #handlePrepared(child: ManagedChild, updateId: string): Promise<void> {
    const pending = this.#state.update;
    if (
      child.role !== "trial" ||
      pending?.status !== "pending" ||
      pending.id !== updateId ||
      pending.targetVersion !== child.version
    ) {
      if (child.role === "trial" && pending?.status === "pending") {
        await this.#returnToPrevious(pending, "rolled-back", "invalid-prepared", child);
        return;
      }
      throw new Error("Trial child reported prepared for an unexpected update.");
    }
    this.#clearTimer();
    const committed = terminalUpdate({ pending, status: "committed" });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.targetVersion,
      update: committed,
    };
    await this.#selectState(next);
    child.role = "active";
    // The commit is already durable, so answer before the cleanup: the trial waits only
    // 30 seconds for this reply, and dropping the backup can take longer than that.
    try {
      await sendMessage(child.process, { type: "committed", updateId: committed.id });
    } finally {
      await discardDatabaseBackup(this.#baseDir, committed.id).catch(() => undefined);
      await this.#repointServiceUnit(committed.targetVersion);
    }
    if (await this.#handOff(child)) return;
    if (this.#child === null && !this.#stopping) await this.#resume();
  }

  /** A stop queued behind the current transition settles the launcher once that transition ends. */
  get #ending(): boolean {
    return this.#stopping || this.#stopRequested;
  }

  /**
   * Updates replace the server child but not this launcher, so a launcher fix reaches a machine
   * only through this hand-off. A launcher that fails its probe, or failed before, leaves this one serving.
   * @returns true when this launcher is done: its delegate ended, it handed back, or a stop is ending it.
   */
  async #handOff(active?: ManagedChild): Promise<boolean> {
    for (;;) {
      const target = this.#state.activeVersion;
      const own = this.#launcherVersion;
      if (
        own === undefined ||
        // A delegate would wait for this launcher's own lock; the repointed unit starts the newer
        // launcher at the service's next start instead.
        this.#lockPath !== undefined ||
        this.#state.update?.status === "pending" ||
        compareExactServiceVersions(target, own) <= 0 ||
        !(await runtimeExists(this.#baseDir, target))
      ) {
        return false;
      }
      if ((await readFailedLauncher(this.#baseDir)) === target) {
        process.stderr.write(
          `[service-launcher] t3@${target} launcher failed before; t3@${own} keeps the service.\n`,
        );
        return false;
      }
      // Without a hand-off, recovery still repoints the unit before the queued stop ends it.
      if (this.#ending) return true;
      const entryPath = runtimePaths(this.#baseDir, target).entryPath;
      if (!(await probeLauncher(entryPath, this.#environment))) {
        process.stderr.write(
          `[service-launcher] t3@${target} launcher failed its probe; t3@${own} keeps the service.\n`,
        );
        return false;
      }
      if (this.#ending) return true;
      if (active !== undefined && this.#child === active) {
        this.#child = null;
        await this.#terminate(active.process);
      }
      if (this.#ending) return true;
      if (this.#handsBack) {
        this.#clearTimer();
        this.#done = true;
        this.#completion.resolve("handed-back");
        return true;
      }
      // The delegate claims serving for the server it starts.
      this.#releaseServing();
      const outcome = await this.#runDelegate(entryPath);
      if (!this.#stopRequested && outcome !== 0 && outcome !== HAND_BACK_EXIT_CODE) {
        // Its server can outlive it, and only the service manager stops every process of the service.
        // Exiting 0 ends every launcher above this one too, since released launchers take a delegate's
        // exit 0 as done, and both service managers restart the service on any exit.
        process.stderr.write(
          `[service-launcher] t3@${target} launcher exited (${String(outcome)}); the service restarts.\n`,
        );
        await NodeFSP.writeFile(failedLauncherPath(this.#baseDir), target, { mode: 0o600 }).catch(
          (cause: unknown) =>
            process.stderr.write(
              `[service-launcher] could not record the failed t3@${target} launcher: ${String(cause)}\n`,
            ),
        );
      }
      if (this.#stopRequested || outcome !== HAND_BACK_EXIT_CODE) {
        this.#done = true;
        this.#completion.resolve("stopped");
        return true;
      }
      await this.#claimServing();
      // The delegate ran the service, so the state on disk is newer than this launcher's copy.
      this.#state = await readServiceState(this.#statePath);
    }
  }

  async #runDelegate(entryPath: string): Promise<number | null> {
    const delegate = NodeChildProcess.spawn(entryPath, ["__service-launcher"], {
      env: { ...this.#environment, [LAUNCHER_DELEGATE_ENV]: "1" },
      stdio: "inherit",
    });
    this.#delegate = delegate;
    try {
      return await new Promise<number | null>((resolve) => {
        delegate.once("error", () => resolve(null));
        delegate.once("exit", (code) => resolve(code));
      });
    } finally {
      this.#delegate = null;
    }
  }

  // Selection is durable before this best-effort unit reconciliation.
  async #repointServiceUnit(version: string): Promise<void> {
    const unit = this.#serviceUnit;
    if (unit === undefined) return;
    try {
      const release = await acquireServiceSelectionLock(unit.path);
      try {
        // The installer writes state before the unit under this lease. Do not
        // acquire its state lease here: the installer takes that lease first.
        const selected = await readServiceState(this.#statePath);
        if (
          selected.activeVersion !== this.#state.activeVersion ||
          selected.update?.id !== this.#state.update?.id ||
          selected.update?.status !== this.#state.update?.status
        ) {
          return;
        }
        const contents = decodeServiceUnit(await NodeFSP.readFile(unit.path));
        const installedBaseDir = serviceUnitBaseDirOf(contents);
        const real = (dir: string) => NodeFSP.realpath(dir).catch(() => NodePath.resolve(dir));
        if (
          installedBaseDir === undefined ||
          (await real(installedBaseDir)) !== (await real(this.#baseDir))
        ) {
          return;
        }
        const repointed = repointServiceUnit(contents, version);
        if (repointed !== contents) {
          await replaceFileDurably(
            unit.path,
            unit.path.endsWith(".xml") ? encodeServiceTask(repointed) : repointed,
          );
        }
        // A previous rename may have succeeded before reload failed.
        await unit.reload();
      } finally {
        release();
      }
    } catch (error) {
      process.stderr.write(
        `[service-launcher] Could not point ${unit.path} at t3@${version}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "trial" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    await this.#returnToPrevious(pending, "rolled-back", "prepared-timeout", child);
  }

  async #handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    this.#child = null;
    if (code === STATE_DIR_OWNED_EXIT_CODE) {
      await this.#idleWhileStateDirOwned();
      return;
    }
    if (child.role === "trial") {
      this.#clearTimer();
      const pending = this.#state.update;
      if (pending?.status !== "pending") {
        throw new Error("Trial child exited without matching pending state.");
      }
      await this.#returnToPrevious(
        pending,
        "rolled-back",
        `candidate-exited:${String(code ?? signal ?? "unknown")}`,
      );
      return;
    }

    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    if (
      await this.#deferForDiskSpace(() =>
        this.#startChild(child.version, "active", this.#state.update),
      )
    )
      return;
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  // Stay idle until the lock frees to avoid supervisor restart loops. A pending update resumes its
  // trial, since the other owner may have migrated the database past fromVersion. It stays pending
  // only once its backup is gone, so no later trial, even after a launcher restart, restores it over
  // the other owner's writes; exit 78 comes before the child opens the database.
  async #idleWhileStateDirOwned(): Promise<void> {
    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      const discarded = await discardDatabaseBackup(this.#baseDir, pending.id).then(
        () => true,
        () => false,
      );
      if (!discarded) {
        const next: ServiceState = {
          ...this.#state,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "state-dir-owned" }),
        };
        await this.#selectState(next);
        await this.#repointServiceUnit(next.activeVersion);
      }
    }
    this.#releaseServing();
    this.#log(
      "[service-launcher] Another T3.CodeShip server owns this T3 home. This service starts again once it stops.\n",
    );
    this.#stateDirFreeProbes = 0;
    // The interval also keeps Node alive: signal listeners alone do not.
    this.#timer = setInterval(
      () => this.#enqueue(() => this.#reclaimStateDir()),
      this.#stateDirOwnerPollMs,
    );
  }

  async #reclaimStateDir(): Promise<void> {
    if (this.#stopRequested) {
      this.#clearTimer();
      return;
    }
    if (this.#timer === undefined || this.#child !== null) return;
    const owned = await stateDirOwned(this.#baseDir);
    // A stop during the probe clears the timer.
    if (this.#timer === undefined) return;
    // A relaunching desktop app frees the home for a few seconds; leave it that gap.
    this.#stateDirFreeProbes = owned ? 0 : this.#stateDirFreeProbes + 1;
    if (this.#stateDirFreeProbes < 2) return;
    this.#clearTimer();
    await this.#claimServing();
    this.#log("[service-launcher] The T3 home is free again. Starting the server.\n");
    const update = this.#state.update;
    if (update?.status === "pending") await this.#startTrial(update);
    else await this.#startChild(this.#state.activeVersion, "active", update);
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    if (child !== undefined) {
      this.#child = null;
      await this.#terminate(child.process);
    }
    if (await this.#deferForDiskSpace(() => this.#returnToPrevious(pending, status, reason)))
      return;
    await restoreDatabaseBackup(this.#baseDir, pending);
    const outcome = terminalUpdate({ pending, status, reason });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.fromVersion,
      update: outcome,
    };
    await this.#selectState(next);
    await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
    try {
      await this.#startChild(next.activeVersion, "active", outcome);
    } finally {
      await this.#repointServiceUnit(next.activeVersion);
    }
  }
}

/** Task Scheduler cannot set variables or redirect output, so a Windows task passes them as flags. */
export interface LauncherOptions {
  readonly baseDir?: string | undefined;
  readonly logFile?: string | undefined;
  readonly serviceUnit?: string | undefined;
}

export async function main(options: LauncherOptions = {}): Promise<void> {
  const baseDir = options.baseDir ?? process.env.T3CODE_HOME;
  if (baseDir === undefined || baseDir.trim() === "") {
    throw new Error("T3CODE_HOME is required by the T3.CodeShip service launcher.");
  }
  const output =
    options.logFile === undefined ? undefined : NodeFS.openSync(options.logFile, "a", 0o600);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const windows = process.platform === "win32";
  let logTimer: NodeJS.Timeout | undefined;
  // A failed stderr write (ENOSPC on a redirected log) is emitted asynchronously; without a listener it is fatal.
  process.stderr.on("error", () => undefined);
  try {
    // What the service manager started the launcher with. It locates the unit; service.env
    // changes only what the server gets.
    const managerEnvironment = {
      ...process.env,
      T3CODE_HOME: baseDir,
      ...(options.serviceUnit === undefined ? {} : { [SERVICE_UNIT_ENV]: options.serviceUnit }),
    };
    const environment = await readServiceEnvironment(baseDir, managerEnvironment);
    const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    const contents = await NodeFSP.readFile(statePath, "utf8");
    let state = parseServiceState(contents);
    if (state === undefined) {
      state = adoptLegacyServiceState(contents);
      if (state === undefined) throw new Error("Service state is invalid or unsupported.");
      if (!(await runtimeExists(baseDir, state.activeVersion))) {
        throw new Error(`Selected t3@${state.activeVersion} runtime is missing or incomplete.`);
      }
    }
    if (process.env[LAUNCHER_PROBE_ENV] === "1") {
      process.stdout.write(`${LAUNCHER_PROBE_OK}\n`);
      return;
    }
    const serviceUnit = await serviceUnitFromEnvironment(managerEnvironment);
    // A delegate's parent bounds the log they both write to.
    const logPath =
      process.env[LAUNCHER_DELEGATE_ENV] === "1"
        ? undefined
        : await serviceLogPath(options, serviceUnit);
    if (logPath !== undefined) {
      await boundServiceLog(logPath);
      logTimer = setInterval(
        () => void boundServiceLog(logPath),
        SERVICE_LOG_CHECK_INTERVAL_MS,
      ).unref();
    }
    const launcher = new Launcher(baseDir, state, {
      environment,
      ...(serviceUnit === undefined ? {} : { serviceUnit }),
      ...(output === undefined ? {} : { output }),
      ...(windows ? { lockPath: serviceLauncherLockPath(baseDir) } : {}),
    });
    // Ending a scheduled task kills its console host without a signal; the console read fails instead.
    const watchConsole = windows && process.stdin.isTTY === true;
    const onConsoleLost = () => void launcher.stop("SIGTERM");
    if (watchConsole) {
      process.stdin.on("error", () => undefined);
      process.stdin.once("close", onConsoleLost);
      process.stdin.resume();
    }
    try {
      const outcome = await launcher.run();
      if (outcome === "handed-back") process.exitCode = HAND_BACK_EXIT_CODE;
    } finally {
      if (watchConsole) {
        process.stdin.off("close", onConsoleLost);
        process.stdin.destroy();
      }
    }
  } catch (cause) {
    if (output !== undefined) {
      NodeFS.writeSync(
        output,
        `[service-launcher] ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
    // Agents the server left behind keep the console host, and so the task, running; ending it
    // lets the next repeating trigger start the service again.
    if (windows && options.serviceUnit !== undefined) {
      const taskName = serviceTaskName(process.env.USERDOMAIN ?? "", process.env.USERNAME ?? "");
      NodeChildProcess.spawnSync(SCHTASKS(), ["/End", "/TN", taskName], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    throw cause;
  } finally {
    clearInterval(logTimer);
    if (output !== undefined) NodeFS.closeSync(output);
  }
}
