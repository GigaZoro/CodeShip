// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat must inspect junctions without following them.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Staging paths use the checkout's native spelling.
import * as NodePath from "node:path";
import { GitCommandError } from "@t3tools/contracts";
import { gitOutputLine } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { existingWorkspacePath } from "../workspace/workspaceLease.ts";
import type { ReleaseRequest } from "../workspace/worktreeReleaseReceipt.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { removeEmptyDirectory } from "./removeEmptyDirectory.ts";

const INDEX_LIST_MAX_BYTES = 64 * 1024 * 1024;
export const windowsRemovalStage = (worktreePath: string) => worktreePath + ".t3-removing";

export const gitFileIdentity = (file: string) =>
  Effect.tryPromise(async () => {
    const stat = await NodeFSP.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.ino === 0n) throw new Error("Expected a linked worktree");
    return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs].join("/");
  });

export const removeEmptyWindowsRemovalStage = Effect.fn("WorktreeRemoval.removeEmptyStage")(
  function* (stage: string, pointerIdentity: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* Effect.tryPromise(() => NodeFSP.lstat(stage))).isDirectory()) return false;
    const files = yield* fs.readDirectory(stage);
    if (!files.length) return true;
    if (files.length !== 1 || files[0] !== ".git") return false;
    const pointer = NodePath.join(stage, ".git");
    if ((yield* gitFileIdentity(pointer)) !== pointerIdentity) return false;
    yield* fs.remove(pointer);
    return yield* removeEmptyDirectory(stage);
  },
);

const entryIdentity = async (target: string) => {
  const stat = await NodeFSP.lstat(target, { bigint: true });
  const directory = stat.isDirectory();
  // Unlinking a child changes its parent's timestamps, but not its directory identity.
  return {
    directory,
    identity: [
      stat.dev,
      stat.ino,
      stat.birthtimeNs,
      ...(directory ? [] : [stat.ctimeNs, stat.size]),
    ].join("/"),
  };
};

/**
 * Git for Windows before 2.54 follows NTFS junctions; newer Git leaves them behind.
 * On Windows, mirror Git's removal checks. The returned effect deletes with Node's
 * `rm`, which unlinks junctions without following them, then drops Git registration.
 * Receipt-based cleanup can verify ownership after the potentially long preflight.
 */
export const prepareLinkedWorktreeRemoval = Effect.fn(
  "WorktreeRemoval.prepareLinkedWorktreeRemoval",
)(function* <A, E, R>(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly force: boolean;
  readonly release?: Pick<ReleaseRequest, "identity" | "head" | "branch">;
  readonly execute: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<A, E, R>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktreePath = input.worktreePath;
  const gitFile = path.join(worktreePath, ".git");
  // Git's own refusals, worded the way it prints them.
  const refuse = (message: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: "git worktree remove",
      cwd: input.cwd,
      detail: `fatal: ${message}`,
      ...(cause === undefined ? {} : { cause }),
    });
  const notAWorktree = refuse(`'${worktreePath}' is not a working tree`);
  // Git refuses to remove a worktree with untracked files unless forced, but
  // its check honors `status.showUntrackedFiles=no` and would delete them.
  const statusConfig = ["-c", "status.showUntrackedFiles=normal"];
  const windows = yield* HostProcess.isWindows;
  const linked =
    windows &&
    (yield* fileSystem.stat(gitFile).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    ));
  if (!linked) {
    if (windows && input.release) return yield* notAWorktree;
    return input.run([
      ...statusConfig,
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      "--",
      worktreePath,
    ]);
  }

  const gitOutput = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    input
      .execute({
        operation: input.operation,
        cwd,
        args,
        maxOutputBytes: INDEX_LIST_MAX_BYTES,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(
        Effect.flatMap((result) =>
          result.stdoutTruncated || result.stderrTruncated
            ? Effect.fail(refuse("incomplete Git inspection"))
            : Effect.succeed(result.stdout),
        ),
      );
  const samePath = (left: string, right: string) =>
    Effect.all([existingWorkspacePath(left), existingWorkspacePath(right)]).pipe(
      Effect.map(([a, b]) => a === b),
      Effect.orElseSucceed(() => false),
    );

  // A registered worktree of this repository: its `.git` file names an admin
  // directory under the common `worktrees/`, whose `gitdir` points back.
  const adminDir = path.resolve(
    worktreePath,
    gitOutputLine(
      yield* gitOutput(worktreePath, ["rev-parse", "--absolute-git-dir"]).pipe(
        Effect.mapError(() => notAWorktree),
      ),
    ),
  );
  const commonDir = path.resolve(
    input.cwd,
    gitOutputLine(yield* gitOutput(input.cwd, ["rev-parse", "--git-common-dir"])),
  );
  const pointsBack = yield* fileSystem.readFileString(path.join(adminDir, "gitdir")).pipe(
    Effect.flatMap((gitdir) => samePath(path.resolve(adminDir, gitOutputLine(gitdir)), gitFile)),
    Effect.orElseSucceed(() => false),
  );
  if (!pointsBack || !(yield* samePath(path.dirname(adminDir), path.join(commonDir, "worktrees"))))
    return yield* notAWorktree;
  // Git counts the file's existence as a lock. T3 passes at most one
  // `--force`, which never removes a locked worktree. Anything but a
  // confirmed absence refuses.
  const lockFile = path.join(adminDir, "locked");
  const locked = yield* fileSystem.stat(lockFile).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(false)
        : Effect.fail(refuse(`cannot inspect the lock of '${worktreePath}'`, error)),
    ),
  );
  if (locked) {
    const reason = (yield* fileSystem.readFileString(lockFile).pipe(Effect.option)).pipe(
      Option.map((text) => text.trim()),
      Option.getOrElse(() => ""),
    );
    return yield* refuse(
      reason === ""
        ? "cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"
        : `cannot remove a locked working tree, lock reason: ${reason}\nuse 'remove -f -f' to override or unlock first`,
    );
  }
  const boundEnv = { GIT_DIR: gitFile, GIT_WORK_TREE: worktreePath };
  let cleanIndex = "";
  if (!input.force) {
    // Bound like Git's own check, so `core.worktree` can't point it elsewhere.
    const submodules = refuse("working trees containing submodules cannot be moved or removed");
    // An unreadable path counts as present, so a doubt refuses.
    const present = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true));
    if (yield* present(path.join(adminDir, "modules"))) return yield* submodules;
    const index = yield* gitOutput(worktreePath, ["ls-files", "--stage", "-z"], boundEnv);
    cleanIndex = index;
    for (const entry of index.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const submodule = entry.slice(entry.indexOf("\t") + 1);
      if (yield* present(path.join(worktreePath, submodule, ".git"))) return yield* submodules;
    }
    const status = yield* gitOutput(
      worktreePath,
      [...statusConfig, "status", "--porcelain", "--ignore-submodules=none"],
      boundEnv,
    );
    if (status !== "")
      return yield* refuse(
        `'${worktreePath}' contains modified or untracked files, use --force to delete it`,
      );
  }

  const inspectError = (cause: unknown) => refuse(`cannot inspect '${worktreePath}'`, cause);
  if (!input.release || input.force) {
    const contents = yield* fileSystem.readFileString(gitFile).pipe(Effect.mapError(inspectError));
    return fileSystem.remove(worktreePath, { recursive: true }).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          if (!(yield* fileSystem.exists(gitFile)))
            yield* fileSystem.writeFileString(gitFile, contents, { flag: "wx" });
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not restore Git pointer after worktree removal failed", {
              error,
            }),
          ),
        ),
      ),
      Effect.andThen(input.run([...statusConfig, "worktree", "remove", "--", worktreePath])),
      Effect.mapError((cause) => refuse(`failed to delete '${worktreePath}'`, cause)),
    );
  }
  const approved = input.release;
  const changed = refuse(`contents of '${worktreePath}' changed during removal`);
  if ((yield* gitFileIdentity(gitFile).pipe(Effect.mapError(inspectError))) !== approved.identity)
    return yield* changed;
  // A sibling can be renamed atomically even when the repository is on another volume.
  // Git may prune its own registration, so no checkout contents belong inside the admin directory.
  const stage = windowsRemovalStage(worktreePath);
  const stagedPointer = path.join(stage, ".git");
  if (yield* fileSystem.exists(stage).pipe(Effect.mapError(inspectError)))
    return yield* refuse(`worktree removal is already staged at '${stage}'`);
  const entries = yield* Effect.tryPromise({
    try: async () => {
      const plan: { relative: string; directory: boolean; identity: string }[] = [];
      const visit = async (directory: string, parent: string) => {
        for (const name of (await NodeFSP.readdir(directory)).sort()) {
          if (!parent && name.toLowerCase() === ".git") continue;
          const target = path.join(directory, name);
          const relative = parent ? parent + "/" + name : name;
          const info = await entryIdentity(target);
          if (info.directory) await visit(target, relative);
          plan.push({ relative, ...info });
        }
      };
      await visit(worktreePath, "");
      return plan;
    },
    catch: inspectError,
  });
  const tracked = new Set(
    cleanIndex
      .split("\0")
      .filter((entry) => /^(100644|100755|120000|160000) /.test(entry))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  );
  const isTrackedFile = (entry: (typeof entries)[number]) =>
    !entry.directory && tracked.has(entry.relative);
  // If a tracked file is locked, leave setup output available to the original checkout.
  const deletionOrder = entries
    .filter(isTrackedFile)
    .concat(entries.filter((entry) => !isTrackedFile(entry)));
  const removedTracked: string[] = [];
  const stagedEnv = { GIT_DIR: adminDir, GIT_WORK_TREE: stage };
  const sameCheckout = Effect.gen(function* () {
    if ((yield* gitFileIdentity(stagedPointer)) !== approved.identity) return false;
    const back = gitOutputLine(yield* fileSystem.readFileString(path.join(adminDir, "gitdir")));
    const branchRef = "refs/heads/" + approved.branch;
    const binding = gitOutputLine(
      yield* gitOutput(stage, ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"], stagedEnv),
    ).split(/\r?\n/);
    return (
      path.relative(path.resolve(adminDir, back), gitFile) === "" &&
      binding.length === 2 &&
      binding[0] === approved.head &&
      binding[1] === branchRef &&
      gitOutputLine(
        yield* gitOutput(stage, ["symbolic-ref", "--no-recurse", "HEAD"], stagedEnv),
      ) === branchRef
    );
  });
  const removeContents = Effect.gen(function* () {
    if (!(yield* sameCheckout)) return yield* changed;
    for (const entry of deletionOrder) {
      const target = path.join(stage, entry.relative);
      if (
        path.relative(path.dirname(target), yield* fileSystem.realPath(path.dirname(target))) !== ""
      )
        return yield* changed;
      if ((yield* Effect.tryPromise(() => entryIdentity(target))).identity !== entry.identity)
        return yield* changed;
      if (entry.directory) {
        if (!(yield* removeEmptyDirectory(target))) return yield* changed;
      } else {
        yield* fileSystem.remove(target);
      }
      if (tracked.has(entry.relative)) removedTracked.push(entry.relative);
    }
  });
  const restoreDeleted = Effect.gen(function* () {
    if ((yield* fileSystem.exists(worktreePath)) || !(yield* sameCheckout)) return;
    if ((yield* gitOutput(stage, ["ls-files", "--stage", "-z"], stagedEnv)) !== cleanIndex) return;
    if (removedTracked.length) {
      // A file written by its owner during removal takes precedence over its indexed contents.
      yield* input.execute({
        operation: input.operation,
        cwd: stage,
        args: ["checkout-index", "-z", "--stdin"],
        env: stagedEnv,
        stdin: removedTracked.join("\0") + "\0",
      });
    }
    if (!(yield* fileSystem.exists(worktreePath))) yield* fileSystem.rename(stage, worktreePath);
  });
  const unregister = Effect.gen(function* () {
    yield* removeContents;
    const remaining = yield* fileSystem.readDirectory(stage);
    if (
      remaining.length !== 1 ||
      remaining[0] !== ".git" ||
      !(yield* sameCheckout) ||
      (yield* fileSystem.exists(worktreePath))
    )
      return yield* changed;
    // Without --force, Git refuses a replacement directory at the original path.
    const result = yield* input.run([...statusConfig, "worktree", "remove", "--", worktreePath]);
    if (
      typeof result === "object" &&
      result !== null &&
      "exitCode" in result &&
      result.exitCode !== 0
    )
      return yield* refuse(`failed to unregister '${worktreePath}'`);
    return result;
  });
  return Effect.gen(function* () {
    if (yield* fileSystem.exists(stage))
      return yield* refuse(`worktree removal is already staged at '${stage}'`);
    yield* fileSystem.rename(worktreePath, stage);
    const result = yield* unregister.pipe(
      Effect.tapError(() =>
        restoreDeleted.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not restore checkout after worktree removal failed", {
              error,
            }),
          ),
        ),
      ),
    );
    if (!(yield* removeEmptyWindowsRemovalStage(stage, approved.identity))) return yield* changed;
    return result;
  }).pipe(Effect.mapError((cause) => refuse(`failed to delete '${worktreePath}'`, cause)));
});
