// @effect-diagnostics nodeBuiltinImport:off -- Receipt keys use the host path and on-disk spelling.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { OrchestrationV2AppThreadLineage, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  existingWorkspacePath,
  foldedWorkspacePath,
  resolveWorkspacePath,
} from "./workspaceLease.ts";
import { missingSetupPath, setupFileStamp } from "../../../../scripts/lib/worktree-setup-proof.ts";

export const gitObjectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const durableRef = Schema.String.check(Schema.isPattern(/^refs\/(?:heads|remotes|archive)\//));
const ReleaseMember = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  projectId: ProjectId,
  lineage: OrchestrationV2AppThreadLineage,
});

export const decodeReleaseMemberRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...ReleaseMember.fields,
    lineage: Schema.fromJsonString(OrchestrationV2AppThreadLineage),
  }),
);
const baseBranchName = Schema.NonEmptyString.check(Schema.isPattern(/^[^-]/));
export const ReleaseRequest = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  worktreePath: Schema.String,
  branch: Schema.String,
  family: Schema.optional(Schema.Array(ReleaseMember)),
  branchBase: Schema.optional(
    Schema.Struct({
      name: Schema.NullOr(baseBranchName),
      legacyName: Schema.optional(baseBranchName),
      ref: Schema.NullOr(
        Schema.NonEmptyString.check(Schema.isPattern(/^refs\/(?:heads|remotes)\//)),
      ),
    }),
  ),
  durableRef,
  alsoDurable: Schema.optional(Schema.Array(durableRef)),
  savedFiles: Schema.optional(Schema.String),
  savedSetupExtras: Schema.optional(Schema.Literal(true)),
  requiresSetupProof: Schema.optional(Schema.Literal(true)),
  savedAllocatedBytes: Schema.optional(Schema.Number),
  head: Schema.String.check(Schema.isPattern(gitObjectIdPattern)),
  identity: Schema.String,
});
export type ReleaseRequest = typeof ReleaseRequest.Type;
const requestJson = Schema.fromJsonString(ReleaseRequest);
export const validateRequest = Schema.decodeEffect(ReleaseRequest);
export const encodeRequest = Schema.encodeEffect(requestJson);
export const decodeReleaseRequest = Schema.decodeUnknownEffect(requestJson, {
  onExcessProperty: "error",
});
export const releaseDigest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export const worktreeReleaseName = (cwd: string) => releaseDigest(cwd) + ".json";
export const releaseFile = (directory: string, cwd: string) =>
  NodePath.join(directory, worktreeReleaseName(cwd));

export class WorktreeReleaseReceiptError extends Schema.TaggedError<WorktreeReleaseReceiptError>()(
  "WorktreeReleaseReceiptError",
  { receipt: Schema.String },
) {
  override get message() {
    return `Cannot verify the worktree release receipt at ${this.receipt}. Inspect this marker and restore a valid receipt for this checkout before retrying.`;
  }
}

const inspectReleaseFile = Effect.fn("WorktreeRelease.inspectFile")(
  function* (file: string) {
    const contents = yield* Effect.tryPromise(async () => {
      const before = await NodeFSP.lstat(file, { bigint: true }).catch(missingSetupPath);
      if (!before) return null;
      if (!before.isFile() || before.ino === 0n || before.size > 1024n * 1024n) return undefined;
      const handle = await NodeFSP.open(
        file,
        NodeFS.constants.O_RDONLY |
          (NodeFS.constants.O_NOFOLLOW ?? 0) |
          (NodeFS.constants.O_NONBLOCK ?? 0),
      );
      try {
        const stamp = setupFileStamp(before);
        if (setupFileStamp(await handle.stat({ bigint: true })) !== stamp)
          throw new Error("Release receipt changed before reading");
        const buffer = Buffer.alloc(Number(before.size) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (
          BigInt(bytesRead) !== before.size ||
          setupFileStamp(await NodeFSP.lstat(file, { bigint: true })) !== stamp
        )
          throw new Error("Release receipt changed while reading");
        const bytes = buffer.subarray(0, bytesRead);
        return NodeBuffer.isUtf8(bytes) ? bytes.toString("utf8") : undefined;
      } finally {
        await handle.close();
      }
    });
    if (contents == null) return contents;
    const request = yield* decodeReleaseRequest(contents).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    return request && { contents, request };
  },
  Effect.timeout("5 seconds"),
  (effect, file) =>
    effect.pipe(Effect.mapError(() => new WorktreeReleaseReceiptError({ receipt: file }))),
);

export const readReleaseFile = Effect.fn("WorktreeRelease.readFile")(function* (
  file: string,
  expectedCheckout?: string,
) {
  const loaded = yield* inspectReleaseFile(file);
  if (
    loaded === undefined ||
    (loaded && expectedCheckout !== undefined && loaded.request.worktreePath !== expectedCheckout)
  )
    return yield* new WorktreeReleaseReceiptError({ receipt: file });
  return loaded;
});

export const releaseReceiptPath = (cwd: string) =>
  resolveWorkspacePath(NodePath.dirname(cwd)).pipe(
    Effect.timeout("5 seconds"),
    Effect.map((parent) => NodePath.join(parent, NodePath.basename(cwd))),
  );

export const releaseStages = [".restoring", ".releasing", ".released", ".setup"] as const;

// A dangling symlink still occupies a candidate directory or receipt name.
export const directoryEntryExists = (target: string) =>
  Effect.tryPromise(async () => {
    try {
      await NodeFSP.lstat(target);
      return true;
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      return false;
    }
  });

type Spelling = { path: string; folded: string };
let lastSpellings: { directory: string; byDigest: Map<string, Spelling> } | undefined;

const stageNames: ReadonlySet<string> = new Set(["", ...releaseStages]);
const markerBase = (name: string) => /^[a-f0-9]{64}\.json/.exec(name)?.[0];
const markerNames = (fs: FileSystem.FileSystem, directory: string) =>
  fs.readDirectory(directory).pipe(
    Effect.map((names) =>
      names
        .filter((name) => {
          const base = markerBase(name);
          return base !== undefined && stageNames.has(name.slice(base.length));
        })
        .toSorted(),
    ),
    Effect.timeout("5 seconds"),
  );
const sameNames = (before: readonly string[], after: readonly string[]) =>
  before.length === after.length && before.every((name, index) => after[index] === name);

const receiptStamp = (file: string) =>
  Effect.tryPromise(async () => setupFileStamp(await NodeFSP.lstat(file, { bigint: true }))).pipe(
    Effect.timeout("5 seconds"),
  );

const sameCheckout = (canonical: string, original: string) =>
  Effect.tryPromise(async () => {
    const current = await NodeFSP.stat(canonical, { bigint: true }).catch(missingSetupPath);
    if (!current || current.ino === 0n) return true;
    const prior = await NodeFSP.stat(original, { bigint: true }).catch(missingSetupPath);
    if (prior && (prior.ino === 0n || (current.dev === prior.dev && current.ino === prior.ino)))
      return true;
    // A removal between the two stats can make a single directory look like two spellings.
    const after = await NodeFSP.stat(canonical, { bigint: true }).catch(missingSetupPath);
    return !after || setupFileStamp(current) !== setupFileStamp(after);
  }).pipe(Effect.timeout("5 seconds"));

export const findCaseVariantReleaseReceipt = Effect.fn("WorktreeRelease.findCaseVariantReceipt")(
  function* (
    fs: FileSystem.FileSystem,
    directory: string,
    canonical: string,
    stages: ReadonlyArray<string>,
  ) {
    const names = yield* markerNames(fs, directory);
    const prior = lastSpellings?.directory === directory ? lastSpellings.byDigest : undefined;
    const byDigest = new Map<string, Spelling>();
    const unresolved = new Map<string, string>();
    const folded = foldedWorkspacePath(canonical);
    let match: string | null = null;
    for (const name of names) {
      const base = markerBase(name)!;
      const file = NodePath.join(directory, name);
      // A validated digest binds its spelling across stage renames and in-place edits.
      let spelling = byDigest.get(base) ?? prior?.get(base);
      if (!spelling) {
        const stamp = yield* receiptStamp(file);
        const loaded = yield* inspectReleaseFile(file);
        if (!loaded || worktreeReleaseName(loaded.request.worktreePath) !== base) {
          // An undecodable marker can be repaired without changing its directory entry.
          unresolved.set(file, stamp);
          continue;
        }
        const path = loaded.request.worktreePath;
        spelling = { path, folded: foldedWorkspacePath(path) };
      }
      byDigest.set(base, spelling);
      if (
        spelling.folded === folded &&
        spelling.path !== canonical &&
        stages.includes(name.slice(base.length)) &&
        (yield* sameCheckout(canonical, spelling.path))
      )
        match = file;
    }
    lastSpellings = { directory, byDigest };
    if (match !== null) return match;
    if (!sameNames(names, yield* markerNames(fs, directory)))
      return yield* new WorktreeReleaseReceiptError({ receipt: directory });
    for (const [file, stamp] of unresolved)
      if ((yield* receiptStamp(file)) !== stamp)
        return yield* new WorktreeReleaseReceiptError({ receipt: file });
    return null;
  },
  (effect, _fs, directory) =>
    effect.pipe(
      Effect.mapError((error) =>
        error._tag === "WorktreeReleaseReceiptError"
          ? error
          : new WorktreeReleaseReceiptError({ receipt: directory }),
      ),
    ),
);

export const releaseReservesWorktree = Effect.fn("WorktreeRelease.releaseReservesWorktree")(
  function* (fs: FileSystem.FileSystem, directory: string, cwd: string) {
    if (!(yield* fs.exists(directory))) return false;
    const canonical = yield* releaseReceiptPath(cwd);
    const base = releaseFile(yield* existingWorkspacePath(directory), canonical);
    for (const stage of ["", ...releaseStages]) {
      const file = base + stage;
      if (
        yield* readReleaseFile(file, canonical).pipe(
          Effect.map((loaded) => loaded !== null),
          Effect.orElseSucceed(() => true),
        )
      )
        return true;
    }
    return (
      (yield* findCaseVariantReleaseReceipt(fs, directory, canonical, ["", ...releaseStages])) !==
      null
    );
  },
);
