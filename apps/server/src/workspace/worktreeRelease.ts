// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";
import { GitCommandError, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { WORKTREE_RELEASE_DIRECTORY } from "../config.ts";
import { existingWorkspacePath, resolveWorkspacePath } from "./workspaceLease.ts";
import {
  decodeReleaseMemberRow,
  decodeReleaseRequest,
  encodeRequest,
  gitObjectIdPattern as oid,
  readReleaseFile,
  releaseFile,
  releaseReceiptPath,
  releaseStages,
  type ReleaseRequest,
  validateRequest,
} from "./worktreeReleaseReceipt.ts";
export {
  decodeReleaseRequest,
  releaseReceiptPath,
  worktreeReleaseName,
  type ReleaseRequest,
} from "./worktreeReleaseReceipt.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  hasSetupOnlyStatus,
  inspectSetupProof,
  readSetupProof,
  setupFileStamp,
  setupProofName,
} from "../../../../scripts/lib/worktree-setup-proof.ts";
import {
  checkWindowsWorktreeFiles,
  WindowsWorktreeInspectionError,
  windowsSetupHost,
} from "../../../../scripts/lib/windows-worktree-files.ts";
import {
  familyCheckoutHook,
  familyHookUnavailable,
  pendingFamilyCheckoutHook,
  runningFamilyCheckoutHook,
  supportsFamilyCheckoutHook,
} from "../vcs/familyWorktreeCheckout.ts";

/** Only a complete subagent or side chat chain within this worktree shares ownership. */
export function worktreeOwner<T extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">>(
  threads: ReadonlyArray<T>,
) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter((thread) => !byId.has(thread.lineage.parentThreadId!));
  if (tops.length !== 1) return undefined;
  const owner = tops[0]!;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        (current.lineage.relationshipToParent !== "subagent" &&
          current.lineage.sideChat !== true) ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent = byId.get(current.lineage.parentThreadId!);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}

export interface CheckoutRecoveryOptions {
  /** A claimed removal may resume the original checkout only after a read-only verification. */
  readonly original?: Pick<
    ReleaseRequest,
    "head" | "identity" | "savedFiles" | "savedSetupExtras" | "requiresSetupProof"
  > & {
    readonly backupDirectory: string;
  };
  /** The checkout was materialized before setup. Setup may already have edited tracked files. */
  readonly setup?: boolean;
  /** Another thread has a live checkout at a completed release's path. Verify it without repairing it. */
  readonly replacementOf?: string;
}
const encodeCheckoutPaths = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const backupName = /^saved-[a-zA-Z0-9_-]+$/;
const releaseName =
  /^[a-f0-9]{64}\.json(?:\.(?:setup|restoring|releasing|released)|\.releasing\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.withdrawn)?$/;

const isWorktreeBackup = Effect.fn("WorktreeRelease.isBackup")(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  saved: string,
) {
  return (
    NodePath.dirname(saved) === (yield* existingWorkspacePath(directory)) &&
    backupName.test(NodePath.basename(saved)) &&
    (yield* fs.exists(saved)) &&
    (yield* existingWorkspacePath(saved)) === saved &&
    (yield* fs.stat(saved)).type === "Directory"
  );
});

export const rememberWorktreeBackup = Effect.fn("WorktreeRelease.rememberBackup")(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  request: ReleaseRequest,
) {
  const saved = request.savedFiles;
  if (saved === undefined) return false;
  if (!(yield* isWorktreeBackup(fs, directory, saved))) return false;
  const root = NodePath.dirname(saved);
  const index = saved + ".json";
  const known = yield* readReleaseFile(fs, index);
  if (
    known?.savedFiles === saved &&
    known.threadId === request.threadId &&
    known.runId === request.runId
  )
    return false;
  const staging = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".backup-" });
  const file = NodePath.join(staging, "receipt");
  yield* fs.writeFileString(file, yield* encodeRequest(request), { mode: 0o600 });
  // Publish without overwriting an existing association.
  yield* fs.link(file, index);
  return true;
}, Effect.scoped);

export const listWorktreeBackups = Effect.fn("WorktreeRelease.listBackups")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = NodePath.join(stateDir, WORKTREE_RELEASE_DIRECTORY);
  if (!(yield* fs.exists(directory))) return [];
  const root = yield* existingWorkspacePath(directory);
  const names = yield* fs.readDirectory(root);
  const legacy = new Map<string, ReleaseRequest>();
  for (const name of names) {
    if (!releaseName.test(name)) continue;
    const entry = yield* readReleaseFile(fs, NodePath.join(root, name));
    if (entry?.savedFiles !== undefined) legacy.set(entry.savedFiles, entry);
  }
  const entries = [];
  for (const name of names.filter((name) => backupName.test(name)).sort()) {
    const savedFiles = NodePath.join(root, name);
    const directoryExists = yield* existingWorkspacePath(savedFiles).pipe(
      Effect.flatMap((real) =>
        real === savedFiles
          ? fs.stat(real).pipe(Effect.map((stat) => stat.type === "Directory"))
          : Effect.succeed(false),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!directoryExists) continue;
    const index = yield* readReleaseFile(fs, savedFiles + ".json");
    const request = index?.savedFiles === savedFiles ? index : legacy.get(savedFiles);
    entries.push({
      savedFiles,
      threadId: request?.threadId ?? null,
      runId: request?.runId ?? null,
      worktreePath: request?.worktreePath ?? null,
      savedAllocatedBytes: request?.savedAllocatedBytes ?? null,
    });
  }
  return entries;
});

// Use on-disk spelling for aliases, including Windows short names. A removed checkout still has a receipt.
export const releasePath = (cwd: string) =>
  resolveWorkspacePath(cwd).pipe(Effect.timeout("5 seconds"));

export const hasNonDirectoryParent = (error: { readonly cause?: unknown }) =>
  error.cause instanceof Error && "code" in error.cause && error.cause.code === "ENOTDIR";

// Historical bindings below a regular file cannot identify a checkout. Other inspection failures must hold a release.
export const observedCheckoutPath = (cwd: string) =>
  releasePath(cwd).pipe(Effect.catchIf(hasNonDirectoryParent, () => Effect.succeed(null)));

export const restoringWorktreeFile = (directory: string, cwd: string) =>
  releaseFile(directory, cwd) + ".restoring";

type RestoreThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "projectId" | "worktreePath" | "branch"
>;

export const releasedWorktree = Effect.fn("WorktreeRelease.readReceipt")(function* <E, E2>(
  fs: FileSystem.FileSystem,
  directory: string,
  canonical: string,
  thread: RestoreThread,
  getParent: (id: ThreadId) => Effect.Effect<RestoreThread | null, E>,
  checkoutExists: boolean,
  verifyReplacement: (identity: string) => Effect.Effect<void, E2>,
) {
  if (!(yield* fs.exists(directory))) return null;
  const file = releaseFile(directory, canonical);
  const setupReceipt = file + ".setup";
  for (const suffix of releaseStages) {
    const receipt = file + suffix;
    if (!(yield* fs.exists(receipt))) continue;
    const contents = yield* fs.readFileString(receipt);
    const request = yield* decodeReleaseRequest(contents);
    // Ordinary singleton starts only resume setup when their checkout already exists.
    if (checkoutExists && !request.family && (suffix === ".releasing" || suffix === ".released"))
      continue;
    const result = { request, contents, receipt, setupReceipt };
    if (request.branch === thread.branch && request.worktreePath === canonical) {
      if (!request.family) {
        if (request.threadId === thread.id) return result;
      } else {
        // Forks copy the source checkout. Roots, paths or branches alone can also belong to strangers.
        const members = new Map(request.family.map((member) => [member.threadId, member]));
        const seen = new Set<ThreadId>();
        let current: RestoreThread | null = thread;
        while (current && !seen.has(current.id) && current.projectId === thread.projectId) {
          const member = members.get(current.id);
          if (member?.projectId === thread.projectId) return result;
          const { parentThreadId, relationshipToParent, rootThreadId }: RestoreThread["lineage"] =
            current.lineage;
          if (
            parentThreadId === null ||
            (relationshipToParent !== "fork" && relationshipToParent !== "subagent") ||
            rootThreadId !== request.threadId ||
            current.branch !== request.branch ||
            current.worktreePath === null ||
            (yield* releaseReceiptPath(current.worktreePath)) !== canonical
          )
            break;
          const parentMember = members.get(parentThreadId);
          if (
            parentMember?.projectId === thread.projectId &&
            parentMember.lineage.rootThreadId === rootThreadId
          )
            return result;
          seen.add(current.id);
          current = yield* getParent(parentThreadId);
          if (current?.id !== parentThreadId) break;
        }
      }
    }
    if (request.family) {
      if (
        suffix === ".released" &&
        checkoutExists &&
        request.worktreePath === canonical &&
        thread.lineage.rootThreadId !== request.threadId &&
        !request.family.some(
          (member) =>
            member.threadId === thread.id || member.threadId === thread.lineage.parentThreadId,
        ) &&
        (request.branch !== thread.branch ||
          request.family.every((member) => member.projectId !== thread.projectId))
      ) {
        yield* verifyReplacement(request.identity);
        continue;
      }
      return yield* new GitCommandError({
        operation: "WorktreeRelease.readReceipt",
        command: "restore",
        cwd: canonical,
        detail: "This thread does not own the released checkout.",
      });
    }
  }
  return null;
});

const gitFileIdentity = (file: string) =>
  Effect.tryPromise(async () => {
    const stat = await NodeFSP.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.ino === 0n) throw new Error("Expected a linked worktree");
    return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs].join("/");
  });

const holdsOnlyFolders = (folder: string) =>
  Effect.tryPromise(
    async () =>
      (await NodeFSP.lstat(folder)).isDirectory() &&
      (await NodeFSP.readdir(folder, { recursive: true, withFileTypes: true })).every((entry) =>
        entry.isDirectory(),
      ),
  );

const readGit = Effect.fn("WorktreeRelease.readGit")(function* (
  cwd: string,
  args: string[],
  options: { readonly maxOutputBytes?: number; readonly stdin?: string } = {},
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "WorktreeRelease.inspect",
    cwd,
    args: [
      "--no-optional-locks",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      ...args,
    ],
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  });
  if (result.stdoutTruncated || result.stderrTruncated || result.stderr.trim() !== "")
    return yield* new GitCommandError({
      operation: "WorktreeRelease.inspect",
      command: args[0]!,
      cwd,
      detail: "Incomplete Git inspection",
    });
  return result.stdout;
});

// An interrupted Git removal is complete only when both the checkout and its registration are gone.
export const interruptedRemovalHold = Effect.fn("WorktreeRelease.interruptedRemovalHold")(
  function* (projectRoot: string, request: ReleaseRequest) {
    const cwd = request.worktreePath;
    const resolved = yield* releasePath(cwd);
    if (NodePath.relative(cwd, resolved) !== "") return "checkout path changed during removal";
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(cwd)) return "checkout path reappeared during removal";
    const listing = yield* readGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
    const records = listing.split("\0\0").filter(Boolean);
    if (!records.length) return "cannot verify Git worktree registrations";
    for (const record of records) {
      const [name, ...fields] = record.split("\0");
      if (!name?.startsWith("worktree ")) return "cannot verify Git worktree registrations";
      if (
        NodePath.relative(cwd, name.slice("worktree ".length)) === "" ||
        fields.includes("branch refs/heads/" + request.branch)
      )
        return "checkout is still registered with Git";
    }
    return null;
  },
);

const worktreeStatus = (cwd: string) =>
  readGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
type BackupCapture = {
  pending: Promise<void>;
  inodes: Set<string>;
  allocatedBytes: number;
};

async function allCompleted<A>(tasks: Promise<A>[]) {
  const results = await Promise.allSettled(tasks);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

async function verifySavedLink(source: string, target: string) {
  const [original, copy] = await Promise.all([
    NodeFSP.lstat(source, { bigint: true }),
    NodeFSP.lstat(target, { bigint: true }),
  ]);
  if (
    (!original.isFile() && !original.isSymbolicLink()) ||
    original.ino === 0n ||
    original.ino !== copy.ino ||
    original.dev !== copy.dev ||
    original.nlink < 2n ||
    copy.nlink < 2n
  )
    throw new Error("Ignored file has no matching retained link");
}

async function verifySavedDirectories(
  platform: NodeJS.Platform,
  cwd: string,
  saved: string,
  pairs: ReadonlyArray<{ source: string; target: string }>,
  signal: AbortSignal,
) {
  if (pairs.length === 0 || platform === "win32") return;
  const options = { signal, timeout: 30_000 };
  const plain = await (async () => {
    if (platform === "darwin") {
      // -f keeps source/backup pairs in argument order. -b escapes embedded newlines in names.
      const paths = pairs.flatMap(({ source, target }) => [source, target]);
      const { stdout, stderr } = await runFile("/bin/ls", ["-ldfnObe@", ...paths], options);
      if (stderr) return false;
      const lines = stdout.trimEnd().split("\n");
      let line = 0;
      const readProvenanceSize = () => {
        const entry = /^d[rwxstST-]{9}(@?) +\d+ +\d+ +\d+ +- +/.exec(lines[line++] ?? "");
        if (!entry) throw new Error("Unverified directory flags or ACL");
        if (!entry[1]) return null;
        // Darwin ls aligns the attribute size with the widest size in this batch.
        const attr = /^\tcom\.apple\.provenance\t *(\d+) *$/.exec(lines[line++] ?? "");
        if (!attr) throw new Error("Unverified directory attribute");
        return attr[1];
      };
      const stamped: string[] = [];
      for (const { source } of pairs) {
        const size = readProvenanceSize();
        if (readProvenanceSize() !== size) return false;
        if (size !== null) stamped.push("./" + NodePath.relative(cwd, source));
      }
      if (line !== lines.length) return false;
      if (!stamped.length) return true;
      // macOS can give both new directories a provenance attribute. Compare all bytes at
      // identical relative names. A different stamp, an extra attribute or an ACL keeps the tree.
      const readValues = (directory: string) =>
        runFile("/usr/bin/xattr", ["-px", "com.apple.provenance", ...stamped], {
          ...options,
          cwd: directory,
          encoding: "buffer",
        });
      const [original, backup] = await Promise.all([readValues(cwd), readValues(saved)]);
      return (
        !original.stderr.length && !backup.stderr.length && original.stdout.equals(backup.stdout)
      );
    }
    if (platform !== "linux") return false;
    const directories = pairs.map(({ source }) => source);
    // After dropping timestamps and long path records, any PAX header carries unsupported metadata.
    const { stdout, stderr } = await runFile(
      "/bin/tar",
      [
        "--create",
        "--file=-",
        "--format=pax",
        "--xattrs",
        "--acls",
        "--selinux",
        "--no-recursion",
        "--pax-option=delete=atime,delete=ctime,delete=mtime,delete=path",
        "-C",
        "/",
        ...directories.map((directory) => "." + directory),
      ],
      { ...options, encoding: "buffer", env: { ...process.env, TAR_OPTIONS: "" } },
    );
    const end = directories.length * 512;
    return (
      stderr.length === 0 &&
      stdout.length >= end + 512 &&
      directories.every((_, index) => stdout[index * 512 + 156] === 53) &&
      stdout.subarray(end, end + 512).every((byte) => byte === 0)
    );
  })().catch(() => false);
  if (!plain) throw new Error("Ignored directory metadata cannot be preserved");
}

// Only unlink a staged name while the source still owns the same inode. Never recursively remove a backup.
async function discardUnpublished(source: string, saved: string): Promise<void> {
  if ((await NodeFSP.realpath(saved)) !== saved || (await NodeFSP.realpath(source)) !== source)
    throw new Error("Backup directory changed");
  const entries = await NodeFSP.readdir(saved, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.includes("\uFFFD")) throw new Error("Uninspectable backup name");
    const original = NodePath.join(source, entry.name);
    const target = NodePath.join(saved, entry.name);
    if (entry.isDirectory()) await discardUnpublished(original, target);
    else {
      await verifySavedLink(original, target);
      await NodeFSP.unlink(target);
    }
  }
  await NodeFSP.rmdir(saved);
}

// A second hard link preserves the file itself, including its metadata and alternate streams.
// Capture never opens file contents or follows directory symlinks.
const inspectIgnored = Effect.fn("WorktreeRelease.inspectIgnored")(function* (
  cwd: string,
  savedFiles: string,
  status: string,
  operation?: BackupCapture | "verify-original",
) {
  const capture = typeof operation === "object" ? operation : undefined;
  const platform = yield* HostProcess.Platform;
  const saved = yield* existingWorkspacePath(savedFiles);
  if (saved !== savedFiles || saved === cwd || saved.startsWith(cwd + NodePath.sep)) return false;
  const pending: string[] = [];
  for (const record of status.split("\0").filter(Boolean)) {
    if (!record.startsWith("!! ")) continue;
    const name = record.slice(3).replace(/\/$/, "");
    if (
      name.includes("\uFFFD") ||
      NodePath.isAbsolute(name) ||
      name
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    )
      return false;
    pending.push(name);
  }
  if (operation === "verify-original") {
    // A whole captured root can disappear before Git removes its registration. Only compare
    // backup names here: a parent created to hold a nested cache also contains installed files in cwd.
    const parents = new Map<string, Set<string>>([[saved, new Set()]]);
    for (const name of pending) {
      let item = NodePath.join(saved, name);
      while (item !== saved) {
        const parent = NodePath.dirname(item);
        const names = parents.get(parent) ?? new Set<string>();
        const child = NodePath.basename(item);
        if (names.has(child)) break;
        names.add(child);
        parents.set(parent, names);
        item = parent;
      }
    }
    for (const [parent, expected] of parents) {
      if ((yield* existingWorkspacePath(parent)) !== parent) return false;
      const actual = yield* Effect.tryPromise(() => NodeFSP.readdir(parent));
      if (actual.length !== expected.size || actual.some((name) => !expected.has(name)))
        return false;
    }
  }
  let count = 0;
  while (pending.length) {
    const batch = pending.splice(-64);
    const results = yield* Effect.tryPromise((signal) => {
      const symlinks = new Map<string, string[]>();
      const directories: Array<{ source: string; target: string; stat: NodeFS.BigIntStats }> = [];
      const work = allCompleted(
        batch.map(async (name) => {
          const source = NodePath.join(cwd, name);
          const target = NodePath.join(saved, name);
          const sourceParent = NodePath.dirname(source);
          const targetParent = NodePath.dirname(target);
          if ((await NodeFSP.realpath(sourceParent)) !== sourceParent)
            throw new Error("Source directory changed");
          if (capture) await NodeFSP.mkdir(targetParent, { recursive: true, mode: 0o700 });
          if ((await NodeFSP.realpath(targetParent)) !== targetParent)
            throw new Error("Saved directory changed");
          const original = await NodeFSP.lstat(source, { bigint: true });
          if (original.isDirectory()) {
            if (capture) await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
            if (
              (await NodeFSP.realpath(target)) !== target ||
              !(await NodeFSP.lstat(target)).isDirectory()
            )
              throw new Error("Missing saved directory");
            directories.push({ source, target, stat: original });
            const children = await NodeFSP.readdir(source);
            if (operation === "verify-original") {
              const savedChildren = new Set(await NodeFSP.readdir(target));
              if (
                children.length !== savedChildren.size ||
                children.some((name) => !savedChildren.has(name))
              )
                throw new Error("The original directory no longer matches its saved files");
            }
            return children.map((child) => {
              if (child.includes("\uFFFD") || child.toLowerCase() === ".git")
                throw new Error("Uninspectable directory");
              return NodePath.join(name, child);
            });
          }
          if (!original.isFile() && !original.isSymbolicLink())
            throw new Error("Special file requires its owner");
          if (capture) {
            const inode = `${original.dev}/${original.ino}`;
            if (!capture.inodes.has(inode)) {
              capture.inodes.add(inode);
              capture.allocatedBytes += Number(original.blocks * 512n);
            }
          }
          if (capture && platform === "darwin" && original.isSymbolicLink()) {
            const siblings = symlinks.get(targetParent) ?? [];
            siblings.push(source);
            symlinks.set(targetParent, siblings);
          } else {
            if (capture) await NodeFSP.link(source, target);
            await verifySavedLink(source, target);
          }
          return [];
        }),
      ).then(async (children) => {
        await verifySavedDirectories(platform, cwd, saved, directories, signal);
        if (platform !== "win32") {
          await allCompleted(
            directories.map(async ({ source, target, stat }) => {
              const mode = Number(stat.mode & 0o7777n);
              if (capture && (mode & 0o7700) === 0o700) await NodeFSP.chmod(target, mode);
              const [current, saved] = await Promise.all([
                NodeFSP.lstat(source, { bigint: true }),
                NodeFSP.lstat(target, { bigint: true }),
              ]);
              if (
                setupFileStamp(current) !== setupFileStamp(stat) ||
                !saved.isDirectory() ||
                current.mode !== saved.mode ||
                current.uid !== saved.uid ||
                current.gid !== saved.gid
              )
                throw new Error("Ignored directory metadata has changed or lacks a preserved copy");
            }),
          );
        }
        // Darwin's link(2) follows the source symlink. ln -P links the inode and accepts siblings in one call.
        for (const [parent, sources] of symlinks) {
          await runFile("/bin/ln", ["-P", ...sources, parent], { signal, timeout: 30_000 });
          await allCompleted(
            sources.map((source) =>
              verifySavedLink(source, NodePath.join(parent, NodePath.basename(source))),
            ),
          );
        }
        return children;
      });
      if (capture)
        capture.pending = work.then(
          () => undefined,
          () => undefined,
        );
      return work;
    }).pipe(Effect.timeout("30 seconds"));
    for (const children of results) {
      for (const child of children) pending.push(child);
    }
    count += batch.length;
    if (count + pending.length > 2_000_000) return false;
  }
  return true;
}, Effect.timeout("10 minutes"));

// Observe one SQLite snapshot, including archived threads. Resolve repeated bindings only once.
const observeFamily = Effect.fn("WorktreeRelease.observeFamily")(function* (
  database: string,
  cwd: string,
  threadId: string,
  runId: string,
  branch: string,
) {
  const hold = (detail: string) =>
    new GitCommandError({
      operation: "WorktreeRelease.observeFamily",
      command: "release-worktree",
      cwd,
      detail,
    });
  const rows = yield* Effect.acquireUseRelease(
    Effect.try(() => new NodeSqlite.DatabaseSync(database, { readOnly: true })),
    (db) =>
      Effect.gen(function* () {
        const paths = yield* Effect.try(() => {
          db.exec("BEGIN");
          return db
            .prepare(`
          SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS storedPath
          FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND storedPath IS NOT NULL
        `)
            .all();
        });
        const matches = yield* Effect.forEach(
          paths,
          ({ storedPath }) =>
            Effect.gen(function* () {
              if (typeof storedPath !== "string" || !NodePath.isAbsolute(storedPath))
                return yield* hold("Cannot verify a saved checkout path.");
              if (storedPath === cwd) return storedPath;
              if ((yield* observedCheckoutPath(storedPath)) !== cwd) return null;
              if ((yield* releaseReceiptPath(storedPath)) !== cwd)
                return yield* hold("A thread points to an alias of the checkout directory itself.");
              return storedPath;
            }),
          { concurrency: 16 },
        );
        const matchingPaths = yield* encodeCheckoutPaths(
          matches.filter((spelling) => spelling !== null),
        );
        return yield* Effect.try(() =>
          db
            .prepare(`
        SELECT t.thread_id AS threadId, t.project_id AS projectId,
          json_extract(t.payload_json, '$.lineage') AS lineage,
          json_extract(t.payload_json, '$.branch') AS branch,
          (SELECT run_id FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
           ORDER BY ordinal DESC, run_id DESC LIMIT 1) AS runId
        FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NULL
          AND json_extract(t.payload_json, '$.worktreePath') IN (SELECT value FROM json_each(?))
        ORDER BY t.thread_id
      `)
            .all(matchingPaths),
        );
      }),
    (db) => Effect.sync(() => db.close()),
  );
  if (rows.length === 0)
    return yield* hold("No thread in this server owns the requested checkout.");
  if (rows.length === 1) {
    const sole = rows[0]!;
    if (sole.threadId !== threadId || sole.runId !== runId || sole.branch !== branch)
      return yield* hold("Only the current owner can release its checkout and run.");
    return undefined;
  }
  if (rows.some((row) => row.runId === null))
    return yield* hold("A thread sharing this checkout has no run to release.");
  const family = yield* Effect.forEach(rows, (row) => decodeReleaseMemberRow(row));
  const owner = worktreeOwner(family.map((member) => ({ ...member, id: member.threadId })));
  if (
    !owner ||
    owner.id !== threadId ||
    owner.lineage.parentThreadId !== null ||
    owner.lineage.rootThreadId !== owner.id ||
    owner.runId !== runId ||
    family.some((member) => member.projectId !== owner.projectId) ||
    rows.some((row) => row.branch !== branch)
  ) {
    return yield* hold("Only the root of the exact checkout family can release its current run.");
  }
  return family;
});

type SetupProof = NonNullable<Awaited<ReturnType<typeof readSetupProof>>>;

const readCheckoutSetupProof = (cwd: string, admin: string, projectRoot: string) =>
  Effect.tryPromise(async () =>
    readSetupProof(
      admin,
      await NodeFSP.realpath(projectRoot),
      setupFileStamp(await NodeFSP.lstat(NodePath.join(cwd, ".git"), { bigint: true })),
    ),
  ).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => null),
  );

const setupExtras = Effect.fn("WorktreeRelease.setupExtras")(function* (
  proof: SetupProof,
  cwd: string,
  status: string,
) {
  const records = status.split("\0").filter(Boolean);
  if (records.some((record) => !record.startsWith("!! "))) return null;
  const setup = records.filter((record) => hasSetupOnlyStatus(proof, record));
  const additions = yield* Effect.tryPromise((signal) =>
    inspectSetupProof(proof, cwd, setup.join("\0"), signal),
  ).pipe(
    Effect.timeout("10 minutes"),
    Effect.orElseSucceed(() => null),
  );
  if (additions === null) return null;
  const owned = new Set(setup);
  // Git collapses these roots into the ignored node_modules entry.
  return [
    ...records.filter((record) => !owned.has(record)),
    ...additions.map((name) => `!! ${name}/`),
  ].join("\0");
});

const setupAdditionsInside = (proof: SetupProof, extras: string) =>
  extras.split("\0").flatMap((record) => {
    const name = record.slice(3).replace(/\/$/, "");
    return Object.keys(proof.modules).some((root) => name.startsWith(root + "/")) ? [name] : [];
  });

const captureSetupExtras = Effect.fn("WorktreeRelease.captureSetupExtras")(function* (cwd: string) {
  const admin = (yield* readGit(cwd, ["rev-parse", "--absolute-git-dir"])).trimEnd();
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(NodePath.join(admin, setupProofName)))) return null;
  const registrations = yield* readGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const main = registrations.split("\0", 1)[0];
  if (!main?.startsWith("worktree ")) return null;
  const proof = yield* readCheckoutSetupProof(cwd, admin, main.slice("worktree ".length));
  return proof && !proof.inPlace
    ? yield* setupExtras(proof, cwd, yield* worktreeStatus(cwd))
    : null;
});

export const queueWorktreeRelease = Effect.fn("WorktreeRelease.queue")(function* (input: {
  stateDir: string;
  dbPath?: string;
  threadId: string;
  runId: string;
  worktreePath: string;
  durableRef: string;
  alsoDurable?: readonly string[];
  saveIgnored?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* releasePath(input.worktreePath);
  const identity = yield* gitFileIdentity(path.join(cwd, ".git"));
  yield* readGit(cwd, ["check-ref-format", input.durableRef]);
  const branchRef = (yield* readGit(cwd, ["symbolic-ref", "HEAD"])).trim();
  if (!branchRef.startsWith("refs/heads/") || branchRef === input.durableRef)
    return yield* new GitCommandError({
      operation: "WorktreeRelease.queue",
      command: "symbolic-ref",
      cwd,
      detail: "The durable ref must be separate from the worktree branch.",
    });
  const directory = path.join(input.stateDir, WORKTREE_RELEASE_DIRECTORY);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const family = input.dbPath
    ? yield* observeFamily(
        input.dbPath,
        cwd,
        input.threadId,
        input.runId,
        branchRef.slice("refs/heads/".length),
      )
    : undefined;
  const request = yield* validateRequest({
    ...(family ? { family } : {}),
    threadId: input.threadId,
    runId: input.runId,
    worktreePath: cwd,
    branch: branchRef.slice("refs/heads/".length),
    durableRef: input.durableRef,
    ...(input.alsoDurable?.length ? { alsoDurable: input.alsoDurable } : {}),
    head: (yield* readGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim(),
    identity,
  });
  const extras = input.saveIgnored
    ? null
    : yield* captureSetupExtras(cwd).pipe(Effect.orElseSucceed(() => null));
  const capture: BackupCapture = {
    pending: Promise.resolve(),
    inodes: new Set(),
    allocatedBytes: 0,
  };
  let unpublished = true;
  let indexed = false;
  const savedFiles =
    input.saveIgnored || extras
      ? yield* Effect.acquireRelease(
          existingWorkspacePath(directory).pipe(
            Effect.flatMap((parent) =>
              fs.makeTempDirectory({ directory: parent, prefix: "saved-" }),
            ),
          ),
          (saved) =>
            unpublished
              ? Effect.promise(() => capture.pending).pipe(
                  Effect.timeout("30 seconds"),
                  Effect.andThen(Effect.tryPromise(() => discardUnpublished(cwd, saved))),
                  Effect.andThen(() => (indexed ? fs.remove(saved + ".json") : Effect.void)),
                  Effect.catch(() =>
                    Effect.logWarning("Retained unpublished worktree backup", { saved }),
                  ),
                )
              : Effect.void,
        )
      : undefined;
  if (savedFiles) {
    const records = extras ?? (yield* worktreeStatus(cwd));
    if (!(yield* inspectIgnored(cwd, savedFiles, records, capture)))
      return yield* new GitCommandError({
        operation: "WorktreeRelease.queue",
        command: "save ignored files",
        cwd,
        detail: `Could not preserve all ignored files in ${savedFiles}.`,
      });
  }
  const savedRequest = {
    ...request,
    ...(savedFiles ? { savedFiles, savedAllocatedBytes: capture.allocatedBytes } : {}),
    ...(extras ? { savedSetupExtras: true as const } : {}),
    ...(extras === "" ? { requiresSetupProof: true as const } : {}),
  };
  const body = yield* encodeRequest(savedRequest);
  const destination = releaseFile(directory, cwd);
  // The worker treats the filename as a commit marker. A partial write must never be consumed.
  const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".release-" });
  const temp = path.join(staging, "request");
  yield* fs.writeFileString(temp, body);
  // A worker can consume the accepted request before rename reports its result.
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      indexed = yield* rememberWorktreeBackup(fs, directory, savedRequest);
      unpublished = false;
      yield* fs.rename(temp, destination).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            unpublished = yield* fs.exists(temp).pipe(Effect.orElseSucceed(() => false));
          }),
        ),
      );
    }),
  );
  return { file: destination, savedFiles, savedAllocatedBytes: capture.allocatedBytes };
}, Effect.scoped);

const readAutoMergeMarker = Effect.fn("WorktreeRelease.readAutoMergeMarker")(function* (
  file: string,
) {
  return yield* Effect.tryPromise(async () => {
    const before = await NodeFSP.lstat(file, { bigint: true });
    if (!before.isFile() || before.size > 65n || before.ino === 0n) return null;
    const handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const buffer = Buffer.alloc(66);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (
        BigInt(bytesRead) !== before.size ||
        setupFileStamp(await handle.stat({ bigint: true })) !== setupFileStamp(before)
      )
        return null;
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => null),
  );
});

const windowsInspectionHold = (
  root: string,
  options: Parameters<typeof checkWindowsWorktreeFiles>[1],
  timeout: "15 seconds" | "10 minutes",
  reason: string,
) =>
  Effect.tryPromise((signal) => checkWindowsWorktreeFiles(root, { ...options, signal })).pipe(
    Effect.as(null),
    Effect.catch(({ cause }) =>
      Effect.succeed(
        cause instanceof WindowsWorktreeInspectionError ? `${reason} (${cause.check})` : reason,
      ),
    ),
    Effect.timeout(timeout),
    Effect.orElseSucceed(() => reason),
  );

const worktreeRegistration = Effect.fn("WorktreeRelease.registration")(function* (
  cwd: string,
  projectRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const admin = yield* existingWorkspacePath(
    (yield* readGit(cwd, ["rev-parse", "--absolute-git-dir"])).trim(),
  );
  const common = yield* existingWorkspacePath(
    (yield* readGit(projectRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim(),
  );
  const backPointer = (yield* fs.readFileString(path.join(admin, "gitdir"))).trimEnd();
  if (
    path.dirname(admin) !== path.join(common, "worktrees") ||
    (yield* existingWorkspacePath(path.resolve(admin, backPointer))) !== path.join(cwd, ".git")
  )
    return null;
  return { admin, common };
});

export const recoverInterruptedWorktree = Effect.fn("WorktreeRelease.recoverCheckout")(function* (
  cwd: string,
  projectRoot: string,
  branch: string,
  options: CheckoutRecoveryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const refuse = (detail: string) =>
    new GitCommandError({
      operation: "WorktreeRelease.recoverCheckout",
      command: "restore",
      cwd,
      detail,
    });
  if (
    (yield* existingWorkspacePath(
      (yield* readGit(cwd, ["rev-parse", "--show-toplevel"])).trim(),
    )) !== cwd
  )
    return yield* refuse("The restored working directory changed.");
  const identity = yield* gitFileIdentity(path.join(cwd, ".git"));
  if (options.replacementOf !== undefined) {
    // A timestamp or permission change updates ctime on the same Git pointer.
    const previous = /^(\d+\/[1-9]\d*\/\d+)\/\d+$/.exec(options.replacementOf);
    if (!previous || identity.startsWith(previous[1] + "/"))
      return yield* refuse("Cannot verify a new Git checkout at the released path.");
  }
  if (
    options.original &&
    (identity !== options.original.identity ||
      (yield* readGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim() !== options.original.head)
  )
    return yield* refuse("The original checkout or its HEAD changed during removal.");
  const registration = yield* worktreeRegistration(cwd, projectRoot);
  if (
    !registration ||
    (yield* readGit(cwd, ["symbolic-ref", "HEAD"])).trim() !== "refs/heads/" + branch
  )
    return yield* refuse("The restored checkout belongs to another repository or branch.");
  const { admin } = registration;
  const adminFiles = yield* fs.readDirectory(admin);
  if (adminFiles.includes(runningFamilyCheckoutHook))
    return yield* refuse(
      "The previous post-checkout hook may still be running. Its outcome needs verification.",
    );
  if (adminFiles.includes("locked") || adminFiles.some((entry) => entry.endsWith(".lock")))
    return yield* refuse("The restored checkout is locked.");
  if (options.setup || options.replacementOf !== undefined) {
    if (adminFiles.includes(pendingFamilyCheckoutHook))
      return yield* refuse("The restored checkout has an unfinished post-checkout hook.");
    if (options.replacementOf !== undefined && !adminFiles.includes("index"))
      return yield* refuse("The new checkout has no working tree index.");
    return;
  }
  const index = path.join(admin, "index");
  const hasIndex = yield* fs.exists(index);
  const pendingHook =
    !options.original && (!hasIndex || adminFiles.includes(pendingFamilyCheckoutHook));
  const hook = Effect.fnUntraced(function* (stage: "prepare" | "finish") {
    if (!pendingHook) return;
    const head = (yield* readGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
    const git = yield* GitVcsDriver.GitVcsDriver;
    yield* familyCheckoutHook(cwd, admin, head, stage, (args) =>
      git
        .execute({ operation: "WorktreeRelease.recoverCheckout", cwd, timeoutMs: null, args })
        .pipe(Effect.map((result) => result.stdout)),
    );
  });
  if (!hasIndex) {
    if (options.original) return yield* refuse("The original checkout lost its index.");
    // A no-checkout registration has no index. A one-tree merge checks for obstructing user files.
    if ((yield* fs.readDirectory(cwd)).some((name) => name !== ".git"))
      return yield* refuse("Interrupted checkout contains local files.");
    yield* hook("prepare");
    yield* readGit(cwd, ["read-tree", "-m", "-u", "HEAD"]);
  }
  if (!(yield* fs.exists(index))) return yield* refuse("The restored checkout has no index.");
  yield* readGit(cwd, ["diff-index", "--cached", "--quiet", "HEAD", "--"]);
  const tracked = yield* readGit(cwd, ["ls-files", "-v", "-z"], {
    maxOutputBytes: 64 * 1024 * 1024,
  });
  if (tracked.split("\0").some((entry) => entry && !entry.startsWith("H ")))
    return yield* refuse("The restored checkout hides tracked files.");
  const trackedStatus = readGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=no",
    "--ignore-submodules=none",
  ]);
  const finish = Effect.gen(function* () {
    if (!pendingHook) return;
    const before = (yield* readGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
    yield* hook("finish");
    const files = yield* fs.readDirectory(admin);
    if (
      files.includes("locked") ||
      files.some((entry) => entry.endsWith(".lock")) ||
      (yield* readGit(cwd, ["symbolic-ref", "HEAD"])).trim() !== "refs/heads/" + branch ||
      (yield* readGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim() !== before ||
      (yield* trackedStatus)
    )
      return yield* refuse("The restored checkout changed during its post-checkout hook.");
  });
  const changes = yield* trackedStatus;
  if (!changes && options.original) {
    const original = options.original;
    const saved = original.savedFiles;
    if (
      (original.savedSetupExtras && saved === undefined) ||
      (saved !== undefined && !(yield* isWorktreeBackup(fs, original.backupDirectory, saved)))
    )
      return yield* refuse("The original checkout backup cannot be verified.");
    const verifySetup =
      original.savedSetupExtras ||
      original.requiresSetupProof ||
      (!saved && adminFiles.includes(setupProofName));
    if (saved || verifySetup) {
      // New untracked files can remain in the owner's checkout. Compare its ignored output with
      // the preserved files and, for a sealed install, verify the dependencies outside the backup.
      const ignored = (yield* worktreeStatus(cwd))
        .split("\0")
        .filter((entry) => entry.startsWith("!! "))
        .join("\0");
      let records = ignored;
      if (verifySetup) {
        const proof = yield* readCheckoutSetupProof(cwd, admin, projectRoot);
        const extras = proof && (yield* setupExtras(proof, cwd, ignored));
        if (extras === null)
          return yield* refuse("The original checkout lost or changed its setup files.");
        records = extras;
      }
      if (saved && !(yield* inspectIgnored(cwd, saved, records, "verify-original")))
        return yield* refuse("The original checkout no longer matches its saved files.");
    }
  }
  if (!changes) return yield* finish;
  if (!options.original && changes.endsWith("\0")) {
    const entries = changes.slice(0, -1).split("\0");
    if (
      entries.every((entry) => entry.startsWith(" D ") && !entry.includes("\uFFFD")) &&
      !(yield* readGit(cwd, ["ls-files", "--killed", "-z"]))
    ) {
      // The index still matches HEAD. Write only its missing paths and never replace existing files.
      yield* readGit(cwd, ["checkout-index", "-z", "--stdin"], {
        stdin: entries.map((entry) => entry.slice(3) + "\0").join(""),
      });
      if (!(yield* trackedStatus)) return yield* finish;
    }
  }
  return yield* refuse("The restored checkout has incomplete or changed tracked files.");
});

export const releaseHold = Effect.fn("WorktreeRelease.inspect")(function* (
  request: ReleaseRequest,
  projectRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = request.worktreePath;
  if (request.family && !(yield* supportsFamilyCheckoutHook((args) => readGit(cwd, args))))
    return familyHookUnavailable;
  if (
    (yield* existingWorkspacePath(
      (yield* readGit(cwd, ["rev-parse", "--show-toplevel"])).trim(),
    )) !== cwd
  )
    return "working directory changed";
  if ((yield* gitFileIdentity(path.join(cwd, ".git"))) !== request.identity)
    return "checkout was replaced";
  const registration = yield* worktreeRegistration(cwd, projectRoot);
  if (!registration) return "checkout registration changed";
  const { admin, common } = registration;
  if (yield* fs.exists(path.join(common, "info", "grafts"))) return "repository uses grafts";
  const anchors: string[] = [];
  for (const ref of new Set([request.durableRef, ...(request.alsoDurable ?? [])])) {
    yield* readGit(cwd, ["check-ref-format", ref]);
    const anchor = (yield* readGit(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)",
      ref,
    ]))
      .trimEnd()
      .split("\0");
    if (
      anchor.length !== 3 ||
      anchor[0] !== ref ||
      !oid.test(anchor[1]!) ||
      anchor[2] !== "" ||
      ref === "refs/heads/" + request.branch
    )
      return "durable ref is unavailable";
    anchors.push(anchor[1]!);
  }
  const currentHead = (yield* readGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!oid.test(currentHead)) return "worktree history could not be inspected";
  if (windowsSetupHost) {
    const hold = yield* windowsInspectionHold(
      admin,
      {},
      "15 seconds",
      "worktree metadata requires its owner",
    );
    if (hold) return hold;
  }
  const tips = new Set([request.head, currentHead]);
  let setupProof: Awaited<ReturnType<typeof readSetupProof>> = null;
  for (const name of yield* fs.readDirectory(admin)) {
    if (["HEAD", "index", "commondir", "gitdir"].includes(name)) continue;
    if (name === setupProofName) {
      setupProof = yield* readCheckoutSetupProof(cwd, admin, projectRoot);
      if (!setupProof) return "worktree setup metadata requires its owner";
      continue;
    }
    let file = path.join(admin, name);
    // Git keeps the emptied folders of a deleted worktree-only ref (refs/worktree, refs/bisect)
    // and of its reflog under logs/refs.
    if (name === "refs") {
      if (!(yield* holdsOnlyFolders(file))) return "worktree has private refs";
      continue;
    }
    if (name === "AUTO_MERGE") {
      const marker = yield* readAutoMergeMarker(file);
      if (marker === null) return "worktree metadata requires its owner";
      const tree = (yield* readGit(cwd, ["rev-parse", "--verify", currentHead + "^{tree}"])).trim();
      if (!oid.test(tree) || marker !== tree + "\n")
        return "worktree has an unpreserved auto-merge tree";
      continue;
    }
    if (name === "logs") {
      if (!(yield* Effect.tryPromise(() => NodeFSP.lstat(file))).isDirectory())
        return "worktree has private reflogs";
      const logs = yield* fs.readDirectory(file);
      for (const log of logs)
        if (log !== "HEAD" && (log !== "refs" || !(yield* holdsOnlyFolders(path.join(file, log)))))
          return "worktree has private reflogs";
      if (!logs.includes("HEAD")) continue;
      file = path.join(file, "HEAD");
    } else if (!["ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG"].includes(name))
      return `worktree metadata ${name} requires its owner`;
    const stat = yield* Effect.tryPromise(() => NodeFSP.lstat(file));
    if (stat.size > 4 * 1024 * 1024 || !stat.isFile())
      return "worktree metadata exceeds inspection limit";
    const contents = yield* fs.readFileString(file);
    if (name === "COMMIT_EDITMSG") {
      if (
        contents.replaceAll("\r\n", "\n") !==
        (yield* readGit(cwd, ["log", "-1", "--format=format:%B", "HEAD"])).replaceAll("\r\n", "\n")
      )
        return "worktree contains an unpreserved commit message";
      continue;
    }
    for (const line of contents.split(/\r?\n/).filter(Boolean)) {
      const hashes = name === "logs" ? line.split(" ", 2) : [line.split("\t")[0]!];
      if (name === "logs" && hashes.length !== 2) return "worktree history could not be inspected";
      for (const hash of hashes) {
        if (!oid.test(hash)) return "worktree history could not be inspected";
        if (!/^0+$/.test(hash)) tips.add(hash);
      }
      if (tips.size > 256) return "worktree history exceeds inspection limit";
    }
  }
  if ((yield* readGit(cwd, ["rev-list", "--max-count=1", ...tips, "--not", ...anchors])).trim())
    return "worktree has commits outside the durable ref";
  const index = yield* readGit(cwd, ["ls-files", "-v", "--stage", "-z"], {
    maxOutputBytes: 64 * 1024 * 1024,
  });
  if (index && !index.endsWith("\0")) return "incomplete worktree index";
  const trackedLinks: string[] = [];
  for (const item of index.split("\0").filter(Boolean)) {
    const entry = /^H (100644|100755|120000|160000) [a-f0-9]+ 0\t/.exec(item);
    if (!entry) return "worktree index contains hidden changes";
    if (windowsSetupHost && entry[1] === "120000") trackedLinks.push(item.slice(entry[0].length));
    if (entry[1] !== "160000") continue;
    // Git status can omit arbitrary files inside an uninitialized gitlink.
    const name = item.slice(entry[0].length);
    if (
      name.includes("\uFFFD") ||
      path.isAbsolute(name) ||
      name.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    )
      return "gitlink path could not be inspected";
    const target = path.join(cwd, name);
    if (
      (yield* existingWorkspacePath(target)) !== target ||
      !(yield* Effect.tryPromise(() => NodeFSP.lstat(target))).isDirectory() ||
      (yield* fs.readDirectory(target)).length
    )
      return "gitlink contains local data";
  }
  const status = yield* worktreeStatus(cwd);
  if (status.split("\0").some((record) => record && !record.startsWith("!! ")))
    return "worktree contains tracked, untracked or ignored local data";
  if (request.requiresSetupProof && !setupProof)
    return "worktree setup metadata requires its owner";
  const fullBackup = request.savedFiles !== undefined && !request.savedSetupExtras;
  if (windowsSetupHost && (!status || request.savedFiles || setupProof)) {
    const hold = yield* windowsInspectionHold(
      cwd,
      {
        links: [...trackedLinks, ...(setupProof?.links.map((link) => link.name) ?? [])],
        modules: fullBackup ? [] : Object.keys(setupProof?.modules ?? {}),
      },
      "10 minutes",
      "Windows worktree contains data or filesystem entries that could not be verified",
    );
    if (hold) return hold;
  }
  if (request.savedFiles && !request.savedSetupExtras) {
    if (
      status &&
      !(yield* inspectIgnored(cwd, request.savedFiles, status).pipe(
        Effect.orElseSucceed(() => false),
      ))
    )
      return "ignored files have changed or lack a preserved copy";
  } else if (status || setupProof || request.savedSetupExtras) {
    // An in-place receipt only authorizes a setup retry. It never vouches for the installed files.
    if (!setupProof || setupProof.inPlace)
      return "worktree contains tracked, untracked or ignored local data";
    const extras = yield* setupExtras(setupProof, cwd, status);
    if (extras === null) return "standard setup output changed or could not be verified";
    if (extras) {
      if (
        !request.savedFiles ||
        !(yield* inspectIgnored(cwd, request.savedFiles, extras).pipe(
          Effect.orElseSucceed(() => false),
        ))
      )
        return "ignored files have changed or lack a preserved copy";
      if (windowsSetupHost) {
        // Setup output is vouched for by the receipt. Anything added inside it is ordinary data.
        const additions = setupAdditionsInside(setupProof, extras);
        if (additions.length) {
          const hold = yield* windowsInspectionHold(
            cwd,
            { targets: additions },
            "10 minutes",
            "Windows worktree contains data or filesystem entries that could not be verified",
          );
          if (hold) return hold;
        }
      }
    }
  }
  return null;
});
