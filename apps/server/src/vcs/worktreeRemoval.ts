// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat must inspect junctions without following them.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hardlink aliases change ctime when unlinked.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Staging paths use the checkout's native spelling.
import * as NodePath from "node:path";
import { GitCommandError } from "@t3tools/contracts";
import { gitOutputLine } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  checkWindowsWorktreeFiles,
  windowsSetupHost,
} from "../../../../scripts/lib/windows-worktree-files.ts";
import {
  missingSetupPath,
  setupFileStamp,
  setupProofName,
} from "../../../../scripts/lib/worktree-setup-proof.ts";

import { existingWorkspacePath } from "../workspace/workspaceLease.ts";
import type { ReleaseRequest } from "../workspace/worktreeReleaseReceipt.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { removeEmptyDirectory } from "./removeEmptyDirectory.ts";

const INDEX_LIST_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REMOVAL_ENTRIES = 2_000_000;
const MAX_REMOVAL_PLAN_BYTES = 256 * 1024 * 1024;
export const windowsRemovalPlanName = "t3-removal-plan-v1";
const WINDOWS_REMOVAL_STAGE_SUFFIX = ".t3-removing";

export const windowsRemovalStage = (worktreePath: string, identity?: string) =>
  identity === undefined
    ? worktreePath + WINDOWS_REMOVAL_STAGE_SUFFIX
    : `${worktreePath}${WINDOWS_REMOVAL_STAGE_SUFFIX}-${NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;

export const windowsRemovalStages = (
  worktreePath: string,
  identity?: string,
): ReadonlyArray<string> =>
  identity === undefined
    ? [windowsRemovalStage(worktreePath)]
    : [windowsRemovalStage(worktreePath, identity), windowsRemovalStage(worktreePath)];

export const listWindowsRemovalStages = Effect.fn("WorktreeRemoval.listStages")(function* (
  worktreePath: string,
) {
  const parent = NodePath.dirname(worktreePath);
  const base = NodePath.basename(worktreePath);
  const legacy = (base + WINDOWS_REMOVAL_STAGE_SUFFIX).toLowerCase();
  const scopedPrefix = (base + WINDOWS_REMOVAL_STAGE_SUFFIX + "-").toLowerCase();
  const entries = yield* Effect.tryPromise(async () => {
    try {
      return await NodeFSP.readdir(parent);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }).pipe(Effect.orElseSucceed(() => null));
  if (entries === null) return null;
  const matches: string[] = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (
      lower === legacy ||
      (lower.startsWith(scopedPrefix) && /^[0-9a-f]{12}$/.test(lower.slice(scopedPrefix.length)))
    ) {
      matches.push(NodePath.join(parent, entry));
    }
  }
  return matches;
});

export const gitFileIdentity = (file: string) =>
  Effect.tryPromise(async () => {
    const stat = await NodeFSP.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.ino === 0n) throw new Error("Expected a linked worktree");
    return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs].join("/");
  });

export const checkoutDirectoryIdentity = (directory: string) =>
  Effect.tryPromise(async () => {
    const stat = await NodeFSP.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.ino === 0n) throw new Error("Expected a worktree directory");
    return [stat.dev, stat.ino, stat.birthtimeNs].join("/");
  });

// A hard link from Git's backlink publishes the lock exclusively and identifies it after a crash.
export const ownsWindowsRemovalLock = (admin: string) =>
  Effect.tryPromise(async () => {
    const locked = await NodeFSP.lstat(NodePath.join(admin, "locked"), { bigint: true }).catch(
      missingSetupPath,
    );
    if (!locked?.isFile() || locked.ino === 0n) return false;
    const backlink = await NodeFSP.lstat(NodePath.join(admin, "gitdir"), { bigint: true });
    return backlink.isFile() && locked.dev === backlink.dev && locked.ino === backlink.ino;
  });

export const clearWindowsRemovalLock = Effect.fn("WorktreeRemoval.clearLock")(function* (
  admin: string,
) {
  if (!(yield* ownsWindowsRemovalLock(admin))) return false;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(NodePath.join(admin, "locked"));
  return true;
});

export const removeEmptyWindowsRemovalStage = Effect.fn("WorktreeRemoval.removeEmptyStage")(
  function* (stage: string, pointerIdentity: string, directoryIdentity?: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* Effect.tryPromise(() => NodeFSP.lstat(stage))).isDirectory()) return false;
    const observed = yield* checkoutDirectoryIdentity(stage);
    const files = yield* fs.readDirectory(stage);
    if (files.length === 0) {
      if (observed !== directoryIdentity) return true;
    } else {
      if (
        files.length !== 1 ||
        files[0] !== ".git" ||
        (directoryIdentity !== undefined && observed !== directoryIdentity)
      )
        return false;
      const pointer = NodePath.join(stage, ".git");
      if ((yield* gitFileIdentity(pointer)) !== pointerIdentity) return false;
      yield* fs.remove(pointer);
    }
    if ((yield* checkoutDirectoryIdentity(stage)) !== observed) return false;
    return yield* removeEmptyDirectory(stage);
  },
);

type RemovalEntry = {
  readonly relative: string;
  readonly directory: boolean;
  readonly identity: string;
};
const RemovalIdentities = Schema.Record(Schema.String, Schema.String);
type RemovalPlan = typeof RemovalIdentities.Type;
const encodeRemovalPlan = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      receiptHash: Schema.String,
      root: Schema.String,
      checkout: RemovalIdentities,
      admin: RemovalIdentities,
      saved: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
);

const pathsOverlap = (left: string, right: string) => {
  const relA = NodePath.relative(left, right);
  const relB = NodePath.relative(right, left);
  return (
    relA === "" ||
    (!relA.startsWith("..") && !NodePath.isAbsolute(relA)) ||
    relB === "" ||
    (!relB.startsWith("..") && !NodePath.isAbsolute(relB))
  );
};

const isValidSavedRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

const verifyBackupPair = async (
  checkoutRoot: string,
  savedRoot: string,
  checkoutRelative: string,
  savedRelative: string,
) => {
  if (NodePath.relative(await NodeFSP.realpath(savedRoot), savedRoot) !== "")
    throw new Error("Saved backup root changed during removal");
  if (pathsOverlap(checkoutRoot, savedRoot)) throw new Error("Saved backup root overlaps checkout");
  const source = NodePath.join(checkoutRoot, checkoutRelative);
  const backup = NodePath.join(savedRoot, savedRelative);
  const backupRel = NodePath.relative(savedRoot, backup);
  if (backupRel === "" || backupRel.startsWith("..") || NodePath.isAbsolute(backupRel))
    throw new Error("Saved backup path escapes backup root");
  const backupParent = NodePath.dirname(backup);
  if (NodePath.relative(backupParent, await NodeFSP.realpath(backupParent)) !== "")
    throw new Error("Saved backup directory changed during removal");
  const [original, copy] = await Promise.all([
    NodeFSP.lstat(source, { bigint: true }),
    NodeFSP.lstat(backup, { bigint: true }),
  ]);
  if (
    !(
      (original.isFile() && copy.isFile()) ||
      (original.isSymbolicLink() && copy.isSymbolicLink())
    ) ||
    original.ino === 0n ||
    original.ino !== copy.ino ||
    original.dev !== copy.dev ||
    original.nlink < 2n ||
    copy.nlink < 2n
  )
    throw new Error(`Saved file backup link is missing or changed: ${checkoutRelative}`);
};

const collectSavedFiles = async (
  savedRoot: string,
  checkoutRoot: string,
  stageRoot: string,
  signal: AbortSignal,
): Promise<string[]> => {
  if (NodePath.relative(await NodeFSP.realpath(savedRoot), savedRoot) !== "")
    throw new Error("Saved backup root is not a canonical directory");
  const rootStat = await NodeFSP.lstat(savedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.ino === 0n)
    throw new Error("Saved backup root is not a directory");
  if (pathsOverlap(savedRoot, checkoutRoot) || pathsOverlap(savedRoot, stageRoot))
    throw new Error("Saved backup root overlaps checkout or stage");
  const saved: string[] = [];
  let count = 0;
  const visit = async (directory: string, parent: string, depth: number) => {
    for (const name of (await NodeFSP.readdir(directory)).sort()) {
      signal.throwIfAborted();
      if (++count > MAX_REMOVAL_ENTRIES || depth > 128)
        throw new Error("Saved backup exceeds removal inspection limit");
      const target = NodePath.join(directory, name);
      const relative = parent ? parent + "/" + name : name;
      const stat = await NodeFSP.lstat(target, { bigint: true });
      if (stat.isDirectory()) {
        await visit(target, relative, depth + 1);
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        await verifyBackupPair(checkoutRoot, savedRoot, relative, relative);
        saved.push(relative);
      } else {
        throw new Error(`Unsupported entry in saved backup: ${relative}`);
      }
    }
  };
  await visit(savedRoot, "", 1);
  return saved;
};
const checkoutIgnored = new Set([".git"]);
const adminIgnored = new Set(["gitdir", "locked", windowsRemovalPlanName]);

const entryIdentity = async (
  target: string,
  retainHardlinkIdentity: boolean | "capture" = false,
  signal?: AbortSignal,
) => {
  const stat = await NodeFSP.lstat(target, { bigint: true });
  if (stat.ino === 0n) throw new Error("File has no removal identity");
  const directory = stat.isDirectory();
  // Unlinking a child changes its parent's timestamps, but not its directory identity.
  const fileId = [stat.dev, stat.ino, stat.birthtimeNs, stat.mode];
  if (directory) return { directory, identity: fileId.join("/") };
  if (
    retainHardlinkIdentity === false ||
    (retainHardlinkIdentity === "capture" && stat.nlink === 1n)
  ) {
    return { directory, identity: [...fileId, stat.ctimeNs, stat.mtimeNs, stat.size].join("/") };
  }

  // Other entries in the plan can alias this inode. Their removal changes its ctime and link count.
  const stable = [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.mtimeNs, stat.size];
  const stamp = (value: typeof stat) =>
    [
      value.dev,
      value.ino,
      value.birthtimeNs,
      value.mode,
      value.ctimeNs,
      value.mtimeNs,
      value.size,
    ].join("/");
  const hash = NodeCrypto.createHash("sha256");
  if (stat.isSymbolicLink()) hash.update(await NodeFSP.readlink(target, { encoding: "buffer" }));
  else if (stat.isFile()) {
    if (stat.size > 512n * 1024n ** 2n)
      throw new Error("Hardlink exceeds removal inspection limit");
    const handle = await NodeFSP.open(target, "r");
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(stat))
        throw new Error("File changed before removal inspection");
      const buffer = Buffer.allocUnsafe(128 * 1024);
      let remaining = Number(stat.size);
      while (remaining > 0) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(remaining, buffer.length),
          null,
        );
        if (bytesRead === 0) throw new Error("File was truncated during removal inspection");
        hash.update(buffer.subarray(0, bytesRead));
        remaining -= bytesRead;
      }
      if (stamp(await handle.stat({ bigint: true })) !== stamp(stat))
        throw new Error("File changed during removal inspection");
    } finally {
      await handle.close();
    }
  } else throw new Error("Unsupported hardlink in removal plan");
  if (stamp(await NodeFSP.lstat(target, { bigint: true })) !== stamp(stat))
    throw new Error("File changed during removal inspection");
  return { directory, identity: `linked/${stable.join("/")}/${hash.digest("hex")}` };
};

const listRemovalEntries = async (
  root: string,
  signal: AbortSignal,
  ignored: ReadonlySet<string>,
  captureHardlinks: boolean,
  approved?: RemovalPlan,
): Promise<RemovalEntry[]> => {
  const entries: RemovalEntry[] = [];
  let count = 0;
  const visit = async (directory: string, parent: string, depth: number) => {
    for (const name of (await NodeFSP.readdir(directory)).sort()) {
      signal.throwIfAborted();
      if (!parent && ignored.has(name.toLowerCase())) continue;
      if (++count > MAX_REMOVAL_ENTRIES || depth > 128)
        throw new Error("Checkout exceeds removal inspection limit");
      const target = NodePath.join(directory, name);
      const relative = parent ? parent + "/" + name : name;
      const expected = approved && Object.getOwnPropertyDescriptor(approved, relative)?.value;
      const hardlink = approved
        ? typeof expected === "string" && expected.startsWith("linked/")
        : captureHardlinks && "capture";
      const info = await entryIdentity(target, hardlink, signal);
      if (approved && info.identity !== expected)
        throw new Error(`Checkout entry changed during removal: ${relative}`);
      if (info.directory) await visit(target, relative, depth + 1);
      entries.push({ relative, ...info });
    }
  };
  await visit(root, "", 1);
  return entries;
};

const identities = (entries: readonly RemovalEntry[]): RemovalPlan =>
  Object.fromEntries(entries.map(({ relative, identity }) => [relative, identity]));

const readRemovalPlan = async (
  file: string,
  expectedReceiptHash: string | undefined,
  requiresSaved: boolean,
) => {
  const before = await NodeFSP.lstat(file, { bigint: true }).catch(missingSetupPath);
  if (!before?.isFile() || before.ino === 0n || before.size > MAX_REMOVAL_PLAN_BYTES)
    throw new Error("Unrecognized Windows removal plan");
  const handle = await NodeFSP.open(file, "r");
  try {
    const stamp = setupFileStamp(before);
    if (setupFileStamp(await handle.stat({ bigint: true })) !== stamp)
      throw new Error("Windows removal plan changed before reading");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (
      BigInt(bytesRead) !== before.size ||
      setupFileStamp(await NodeFSP.lstat(file, { bigint: true })) !== stamp
    )
      throw new Error("Windows removal plan changed while reading");
    const plan = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (
      !expectedReceiptHash ||
      plan?.receiptHash !== expectedReceiptHash ||
      typeof plan.root !== "string" ||
      !plan.checkout ||
      typeof plan.checkout !== "object" ||
      Array.isArray(plan.checkout) ||
      !plan.admin ||
      typeof plan.admin !== "object" ||
      Array.isArray(plan.admin) ||
      (requiresSaved && !Array.isArray(plan.saved)) ||
      (!requiresSaved && plan.saved !== undefined) ||
      (plan.saved !== undefined &&
        (!Array.isArray(plan.saved) || !plan.saved.every(isValidSavedRelativePath)))
    )
      throw new Error("Unrecognized Windows removal plan");
    return plan as {
      root: string;
      checkout: RemovalPlan;
      admin: RemovalPlan;
      saved?: ReadonlyArray<string>;
    };
  } finally {
    await handle.close();
  }
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
  readonly release?: Pick<
    ReleaseRequest,
    "identity" | "head" | "branch" | "directoryIdentity" | "savedFiles" | "savedSetupExtras"
  > & {
    readonly setupReceiptHash?: string;
  };
  readonly resume?: boolean;
  readonly verifyReleaseHistory?: Effect.Effect<
    void,
    GitCommandError | PlatformError.PlatformError | Cause.UnknownError
  >;
  readonly execute: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<A, E, R>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktreePath = input.worktreePath;
  const gitFile = path.join(worktreePath, ".git");
  const resuming = input.resume === true;
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
  const legacyStage = windowsRemovalStage(worktreePath);
  let stage = legacyStage;
  if (resuming) {
    if (!input.release || input.force) return yield* notAWorktree;
    let foundStage: string | undefined;
    for (const candidate of windowsRemovalStages(worktreePath, input.release.identity)) {
      const canonicalCandidate = yield* existingWorkspacePath(candidate).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (canonicalCandidate !== candidate) continue;
      const candidatePointer = path.join(candidate, ".git");
      const isPointerFile = yield* fileSystem.stat(candidatePointer).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      );
      if (!isPointerFile) continue;
      if (
        (yield* gitFileIdentity(candidatePointer).pipe(Effect.orElseSucceed(() => undefined))) ===
        input.release.identity
      ) {
        foundStage = candidate;
        break;
      }
    }
    if (!foundStage) return yield* notAWorktree;
    stage = foundStage;
  } else if (input.release) {
    const legacyPresent = yield* Effect.tryPromise(async () => {
      const stat = await NodeFSP.lstat(legacyStage).catch(missingSetupPath);
      if (!stat) return "missing" as const;
      if (
        stat.isDirectory() &&
        NodePath.relative(await NodeFSP.realpath(legacyStage), legacyStage) === "" &&
        (await NodeFSP.readdir(legacyStage)).length === 0
      )
        return "empty-dir" as const;
      return "occupied" as const;
    }).pipe(Effect.mapError((cause) => refuse(`cannot inspect '${worktreePath}'`, cause)));
    if (legacyPresent === "empty-dir") {
      stage = windowsRemovalStage(worktreePath, input.release.identity);
    }
  }
  const stagedPointer = path.join(stage, ".git");
  const checkout = resuming ? stage : worktreePath;
  const pointer = resuming ? stagedPointer : gitFile;
  // Git refuses to remove a worktree with untracked files unless forced, but
  // its check honors `status.showUntrackedFiles=no` and would delete them.
  const statusConfig = ["-c", "status.showUntrackedFiles=normal"];
  const windows = yield* HostProcess.isWindows;
  const linked =
    windows &&
    (yield* fileSystem.stat(pointer).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    ));
  if (!linked) {
    if (resuming || (windows && input.release)) return yield* notAWorktree;
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
    checkout,
    gitOutputLine(
      yield* gitOutput(checkout, ["rev-parse", "--absolute-git-dir"]).pipe(
        Effect.mapError(() => notAWorktree),
      ),
    ),
  );
  const commonDir = path.resolve(
    input.cwd,
    gitOutputLine(yield* gitOutput(input.cwd, ["rev-parse", "--git-common-dir"])),
  );
  const pointsBack = yield* fileSystem.readFileString(path.join(adminDir, "gitdir")).pipe(
    Effect.flatMap((gitdir) => {
      const backlink = path.resolve(adminDir, gitOutputLine(gitdir));
      return resuming
        ? Effect.succeed(path.relative(backlink, gitFile) === "")
        : samePath(backlink, gitFile);
    }),
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
  if (
    locked &&
    !(
      resuming &&
      (yield* ownsWindowsRemovalLock(adminDir).pipe(Effect.mapError(() => notAWorktree)))
    )
  ) {
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
  if (!input.force && !resuming) {
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
  if ((yield* gitFileIdentity(pointer).pipe(Effect.mapError(inspectError))) !== approved.identity)
    return yield* changed;
  // A sibling can be renamed atomically even when the repository is on another volume.
  // Git may prune its own registration, so no checkout contents belong inside the admin directory.
  if (!resuming && (yield* fileSystem.exists(stage).pipe(Effect.mapError(inspectError))))
    return yield* refuse(`worktree removal is already staged at '${stage}'`);
  const setupProof = path.join(adminDir, setupProofName);
  const setupReceiptHash =
    approved.setupReceiptHash &&
    (resuming || (yield* fileSystem.exists(setupProof).pipe(Effect.mapError(inspectError))))
      ? approved.setupReceiptHash
      : undefined;
  const planFile = path.join(adminDir, windowsRemovalPlanName);
  const inspect = <B>(read: (signal: AbortSignal) => Promise<B>) =>
    Effect.tryPromise(read).pipe(Effect.timeout("10 minutes"), Effect.mapError(inspectError));
  const savedRoot = approved.savedFiles;
  const plan = resuming
    ? yield* inspect(() => readRemovalPlan(planFile, setupReceiptHash, savedRoot !== undefined))
    : undefined;
  const savedList = resuming
    ? plan?.saved
    : savedRoot !== undefined
      ? yield* inspect((signal) => collectSavedFiles(savedRoot, worktreePath, stage, signal))
      : undefined;
  const savedMap = new Map<string, string>(
    (savedList ?? []).map((relative) => [windows ? relative.toLowerCase() : relative, relative]),
  );
  const root = yield* checkoutDirectoryIdentity(checkout).pipe(Effect.mapError(inspectError));
  if (
    plan &&
    (root !== plan.root ||
      (yield* fileSystem.exists(worktreePath).pipe(Effect.mapError(inspectError))))
  )
    return yield* changed;
  const entries = yield* inspect((signal) =>
    listRemovalEntries(
      checkout,
      signal,
      checkoutIgnored,
      setupReceiptHash !== undefined,
      plan?.checkout,
    ),
  );
  const admin = setupReceiptHash
    ? (plan?.admin ??
      identities(
        yield* inspect((signal) => listRemovalEntries(adminDir, signal, adminIgnored, false)),
      ))
    : undefined;
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
    if (
      !(yield* ownsWindowsRemovalLock(adminDir)) ||
      (yield* gitFileIdentity(stagedPointer)) !== approved.identity
    )
      return false;
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
  const verifyAdmin = Effect.gen(function* () {
    if (!admin) return;
    const remaining = yield* inspect((signal) =>
      listRemovalEntries(adminDir, signal, adminIgnored, false, admin),
    );
    if (remaining.length !== Object.keys(admin).length) return yield* changed;
  });
  const removeContents = Effect.gen(function* () {
    if (
      !(yield* sameCheckout) ||
      (yield* checkoutDirectoryIdentity(stage)) !== root ||
      (yield* fileSystem.exists(worktreePath)) ||
      (approved.setupReceiptHash && !setupReceiptHash && (yield* fileSystem.exists(setupProof)))
    )
      return yield* changed;
    if (input.verifyReleaseHistory) yield* input.verifyReleaseHistory;
    yield* verifyAdmin;
    if (setupReceiptHash && admin) {
      // Recheck metadata whose contents are outside Node's timestamps and primary data stream.
      if (windowsSetupHost)
        yield* inspect((signal) =>
          checkWindowsWorktreeFiles(stage, { privateStage: true, signal }),
        );
      if (resuming && windowsSetupHost) {
        const targets = (yield* fileSystem.readDirectory(adminDir)).filter(
          (name) => name !== windowsRemovalPlanName,
        );
        yield* inspect((signal) => checkWindowsWorktreeFiles(adminDir, { targets, signal }));
      }
      if (!resuming) {
        const encoded = yield* encodeRemovalPlan({
          receiptHash: setupReceiptHash,
          root,
          checkout: identities(entries),
          admin,
          ...(savedList !== undefined ? { saved: savedList } : {}),
        });
        const contents = Buffer.from(encoded);
        if (contents.length > MAX_REMOVAL_PLAN_BYTES) return yield* changed;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const temp = yield* fileSystem.makeTempFileScoped({
              directory: commonDir,
              prefix: "t3-removal-",
            });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* fileSystem.open(temp, { flag: "w" });
                yield* handle.writeAll(contents);
                yield* handle.sync;
              }),
            );
            yield* fileSystem.link(temp, planFile);
          }),
        );
      }
    }
    for (const entry of deletionOrder) {
      const target = path.join(stage, entry.relative);
      if (
        path.relative(path.dirname(target), yield* fileSystem.realPath(path.dirname(target))) !== ""
      )
        return yield* changed;
      if (
        (yield* Effect.tryPromise((signal) =>
          entryIdentity(target, entry.identity.startsWith("linked/"), signal),
        )).identity !== entry.identity
      )
        return yield* changed;
      if (entry.directory) {
        if (!(yield* removeEmptyDirectory(target))) return yield* changed;
      } else {
        const savedRelative =
          savedRoot !== undefined
            ? savedMap.get(windows ? entry.relative.toLowerCase() : entry.relative)
            : undefined;
        if (savedRoot !== undefined && savedRelative !== undefined) {
          yield* Effect.tryPromise(() =>
            verifyBackupPair(stage, savedRoot, entry.relative, savedRelative),
          ).pipe(Effect.mapError(() => changed));
        }
        yield* fileSystem.remove(target);
      }
      if (tracked.has(entry.relative)) removedTracked.push(entry.relative);
    }
  });
  const restoreDeleted = Effect.gen(function* () {
    // A partially removed setup no longer matches the aggregate seal. Keep its exact deletion
    // plan with the staged checkout so either cleanup or its owner can finish the release.
    if (setupReceiptHash && (yield* fileSystem.exists(planFile))) return;
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
    if (!(yield* fileSystem.exists(worktreePath))) {
      yield* fileSystem.rename(stage, worktreePath);
      yield* clearWindowsRemovalLock(adminDir);
    }
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
    if (input.verifyReleaseHistory) yield* input.verifyReleaseHistory;
    yield* verifyAdmin;
    if (!(yield* clearWindowsRemovalLock(adminDir))) return yield* changed;
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
    if (
      approved.directoryIdentity !== undefined &&
      (yield* checkoutDirectoryIdentity(checkout)) !== approved.directoryIdentity
    )
      return yield* changed;
    if (resuming) {
      if (!(yield* ownsWindowsRemovalLock(adminDir))) {
        const remaining = yield* fileSystem.readDirectory(stage);
        if (remaining.length !== 1 || remaining[0] !== ".git") return yield* changed;
        yield* fileSystem.link(path.join(adminDir, "gitdir"), lockFile);
      }
    } else {
      if (yield* fileSystem.exists(stage))
        return yield* refuse(`worktree removal is already staged at '${stage}'`);
      yield* fileSystem.link(path.join(adminDir, "gitdir"), lockFile);
      yield* fileSystem.rename(worktreePath, stage);
    }
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
    if (
      !(yield* removeEmptyWindowsRemovalStage(stage, approved.identity, approved.directoryIdentity))
    )
      return yield* changed;
    return result;
  }).pipe(Effect.mapError((cause) => refuse(`failed to delete '${worktreePath}'`, cause)));
});
