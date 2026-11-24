// @effect-diagnostics nodeBuiltinImport:off
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
) {
  if (!(yield* fs.exists(directory))) return null;
  const parent = yield* releasePath(NodePath.dirname(cwd));
  const canonical = NodePath.join(parent, NodePath.basename(cwd));
  const file = releaseFile(directory, canonical);
  for (const suffix of [".releasing", ".released"]) {
    const receipt = file + suffix;
    if (!(yield* fs.exists(receipt))) continue;
    const request = yield* decodeReleaseRequest(yield* fs.readFileString(receipt));
    if (
      request.threadId === threadId &&
      request.branch === branch &&
      request.worktreePath === canonical
    )
      return { request, receipt };
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
type BackupCapture = { pending: Promise<void> };

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
  const mac = (yield* HostProcess.Platform) === "darwin";
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
            return (await NodeFSP.readdir(source)).map((child) => {
              if (child.includes("\uFFFD") || child.toLowerCase() === ".git")
                throw new Error("Uninspectable directory");
              return NodePath.join(name, child);
            });
          }
          if (!original.isFile() && !original.isSymbolicLink())
            throw new Error("Special file requires its owner");
          if (capture && mac && original.isSymbolicLink()) {
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
  const capture: BackupCapture = { pending: Promise.resolve() };
  let unpublished = true;
  const savedFiles = input.saveIgnored
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
                Effect.catch(() =>
                  Effect.logWarning("Retained unpublished worktree backup", { saved }),
                ),
              )
            : Effect.void,
      )
    : undefined;
  if (savedFiles) {
    const records = yield* worktreeStatus(cwd);
    if (!(yield* inspectIgnored(cwd, savedFiles, records, capture)))
      return yield* new GitCommandError({
        operation: "WorktreeRelease.queue",
        command: "save ignored files",
        cwd,
        detail: `Could not preserve all ignored files in ${savedFiles}.`,
      });
  }
  const body = yield* encodeRequest({ ...request, ...(savedFiles ? { savedFiles } : {}) });
  const destination = releaseFile(directory, cwd);
  // The worker treats the filename as a commit marker. A partial write must never be consumed.
  const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".release-" });
  const temp = path.join(staging, "request");
  yield* fs.writeFileString(temp, body);
  // A worker can consume the accepted request before rename reports its result.
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
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
  return { file: destination, savedFiles };
}, Effect.scoped);

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
  const tips = new Set([request.head]);
  for (const name of yield* fs.readDirectory(admin)) {
    if (["HEAD", "index", "commondir", "gitdir"].includes(name)) continue;
    let file = path.join(admin, name);
    if (name === "refs") {
      // Git leaves refs/ folders here, empty or holding worktree-only refs (refs/worktree, refs/bisect).
      if (
        !(yield* Effect.tryPromise(() => NodeFSP.lstat(file))).isDirectory() ||
        (yield* Effect.tryPromise(() =>
          NodeFSP.readdir(file, { recursive: true, withFileTypes: true }),
        )).some((entry) => !entry.isDirectory())
      )
        return "worktree has private refs";
      continue;
    }
    if (name === "logs") {
      const logs = yield* fs.readDirectory(file);
      if (logs.length !== 1 || logs[0] !== "HEAD") return "worktree has private reflogs";
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
  const index = yield* readGit(cwd, ["ls-files", "-v", "--stage", "-z"], 64 * 1024 * 1024);
  if (index && !index.endsWith("\0")) return "incomplete worktree index";
  for (const item of index.split("\0").filter(Boolean)) {
    const entry = /^H (100644|100755|120000|160000) [a-f0-9]+ 0\t/.exec(item);
    if (!entry) return "worktree index contains hidden changes";
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
  if (status) {
    if (
      !request.savedFiles ||
      status.split("\0").some((record) => record && !record.startsWith("!! "))
    )
      return "worktree contains tracked, untracked or ignored local data";
    if (
      !(yield* inspectIgnored(cwd, request.savedFiles, status).pipe(
        Effect.orElseSucceed(() => false),
      ))
    )
      return "ignored files have changed or lack a preserved copy";
  }
  return null;
});
