// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { GitCommandError, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { WORKTREE_RELEASE_DIRECTORY } from "../config.ts";
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

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const durableRef = Schema.String.check(Schema.isPattern(/^refs\/(?:heads|remotes|archive)\//));
const ReleaseRequest = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  worktreePath: Schema.String,
  branch: Schema.String,
  durableRef,
  alsoDurable: Schema.optional(Schema.Array(durableRef)),
  savedFiles: Schema.optional(Schema.String),
  savedSetupExtras: Schema.optional(Schema.Literal(true)),
  savedAllocatedBytes: Schema.optional(Schema.Number),
  head: Schema.String.check(Schema.isPattern(oid)),
  identity: Schema.String,
});
export type ReleaseRequest = typeof ReleaseRequest.Type;
const requestJson = Schema.fromJsonString(ReleaseRequest);
const validateRequest = Schema.decodeEffect(ReleaseRequest);
const encodeRequest = Schema.encodeEffect(requestJson);
export const decodeReleaseRequest = Schema.decodeUnknownEffect(requestJson, {
  onExcessProperty: "error",
});
export const worktreeReleaseName = (cwd: string) =>
  NodeCrypto.createHash("sha256").update(cwd).digest("hex") + ".json";
const releaseFile = (directory: string, cwd: string) =>
  NodePath.join(directory, worktreeReleaseName(cwd));
const backupName = /^saved-[a-zA-Z0-9_-]+$/;
const releaseName = /^[a-f0-9]{64}\.json(?:\.(?:setup|releasing|released))?$/;

const readReleaseFile = Effect.fn("WorktreeRelease.readFile")(
  function* (fs: FileSystem.FileSystem, file: string) {
    if ((yield* fs.realPath(file)) !== file) return null;
    const stat = yield* fs.stat(file);
    if (stat.type !== "File" || stat.size > 128n * 1024n) return null;
    return yield* decodeReleaseRequest(yield* fs.readFileString(file));
  },
  Effect.timeout("5 seconds"),
  Effect.orElseSucceed(() => null),
);

export const rememberWorktreeBackup = Effect.fn("WorktreeRelease.rememberBackup")(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  request: ReleaseRequest,
) {
  const saved = request.savedFiles;
  if (saved === undefined) return false;
  const root = yield* fs.realPath(directory);
  if (
    NodePath.dirname(saved) !== root ||
    !backupName.test(NodePath.basename(saved)) ||
    !(yield* fs.exists(saved)) ||
    (yield* fs.realPath(saved)) !== saved ||
    (yield* fs.stat(saved)).type !== "Directory"
  )
    return false;
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
  const root = yield* fs.realPath(directory);
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
    const directoryExists = yield* fs.realPath(savedFiles).pipe(
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
  Effect.tryPromise(() => NodeFSP.realpath(cwd)).pipe(
    Effect.catchIf(
      (error) =>
        error.cause instanceof Error && "code" in error.cause && error.cause.code === "ENOENT",
      () => Effect.succeed(cwd),
    ),
    Effect.timeout("5 seconds"),
  );

export const releasedWorktree = Effect.fn("WorktreeRelease.readReceipt")(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  cwd: string,
  threadId: string,
  branch: string,
  checkoutExists: boolean,
) {
  if (!(yield* fs.exists(directory))) return null;
  const parent = yield* releasePath(NodePath.dirname(cwd));
  const canonical = NodePath.join(parent, NodePath.basename(cwd));
  const file = releaseFile(directory, canonical);
  const setupReceipt = file + ".setup";
  for (const suffix of checkoutExists ? [".setup"] : [".releasing", ".released", ".setup"]) {
    const receipt = file + suffix;
    if (!(yield* fs.exists(receipt))) continue;
    const contents = yield* fs.readFileString(receipt);
    const request = yield* decodeReleaseRequest(contents);
    if (
      request.threadId === threadId &&
      request.branch === branch &&
      request.worktreePath === canonical
    )
      return { request, contents, receipt, setupReceipt };
  }
  return null;
});

const gitFileIdentity = (file: string) =>
  Effect.tryPromise(async () => {
    const stat = await NodeFSP.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.ino === 0n) throw new Error("Expected a linked worktree");
    return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs].join("/");
  });

const readGit = Effect.fn("WorktreeRelease.readGit")(function* (
  cwd: string,
  args: string[],
  maxOutputBytes = 4 * 1024 * 1024,
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
    maxOutputBytes,
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

async function verifyPlainDirectories(
  platform: NodeJS.Platform,
  directories: readonly string[],
  signal: AbortSignal,
) {
  if (directories.length === 0 || platform === "win32") return;
  const options = { signal, timeout: 30_000 };
  const plain = await (async () => {
    if (platform === "darwin") {
      // The mode suffix marks xattrs and ACLs. The flags column is "-" for an ordinary directory.
      const { stdout, stderr } = await runFile("/bin/ls", ["-ldnObe@", ...directories], options);
      const entries = stdout.trimEnd().split("\n");
      return (
        !stderr &&
        entries.length === directories.length &&
        entries.every((entry) => /^d[rwxstST-]{9} +\d+ +\d+ +\d+ +- +/.test(entry))
      );
    }
    if (platform !== "linux") return false;
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
  capture?: BackupCapture,
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const saved = yield* fs.realPath(savedFiles);
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
            return (await NodeFSP.readdir(source)).map((child) => {
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
        await verifyPlainDirectories(
          platform,
          directories.map(({ source }) => source),
          signal,
        );
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
  const request = yield* validateRequest({
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
          fs
            .realPath(directory)
            .pipe(
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

export const releaseHold = Effect.fn("WorktreeRelease.inspect")(function* (
  request: ReleaseRequest,
  projectRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = request.worktreePath;
  if ((yield* fs.realPath((yield* readGit(cwd, ["rev-parse", "--show-toplevel"])).trim())) !== cwd)
    return "working directory changed";
  if ((yield* gitFileIdentity(path.join(cwd, ".git"))) !== request.identity)
    return "checkout was replaced";
  const admin = yield* fs.realPath(
    (yield* readGit(cwd, ["rev-parse", "--absolute-git-dir"])).trim(),
  );
  const common = yield* fs.realPath(
    (yield* readGit(projectRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).trim(),
  );
  const backPointer = (yield* fs.readFileString(path.join(admin, "gitdir"))).trimEnd();
  if (
    path.dirname(admin) !== path.join(common, "worktrees") ||
    (yield* fs.realPath(path.resolve(admin, backPointer))) !== path.join(cwd, ".git")
  )
    return "checkout registration changed";
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
    if (name === "refs") {
      // Git 2.56 initializes an empty refs directory for a new linked worktree.
      if (
        !(yield* Effect.tryPromise(() => NodeFSP.lstat(file))).isDirectory() ||
        (yield* fs.readDirectory(file)).length !== 0
      )
        return "worktree has private refs";
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
      const logs = yield* fs.readDirectory(file);
      if (logs.length !== 1 || logs[0] !== "HEAD") return "worktree has private reflogs";
      file = path.join(file, "HEAD");
    } else if (!["ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG"].includes(name))
      return "worktree metadata requires its owner";
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
  const index = yield* readGit(cwd, ["ls-files", "-v", "--stage", "-z"], 64 * 1024 * 1024);
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
      (yield* fs.realPath(target)) !== target ||
      !(yield* Effect.tryPromise(() => NodeFSP.lstat(target))).isDirectory() ||
      (yield* fs.readDirectory(target)).length
    )
      return "gitlink contains local data";
  }
  const status = yield* worktreeStatus(cwd);
  if (status.split("\0").some((record) => record && !record.startsWith("!! ")))
    return "worktree contains tracked, untracked or ignored local data";
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
