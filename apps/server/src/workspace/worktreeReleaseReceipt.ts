// @effect-diagnostics nodeBuiltinImport:off -- Receipt keys use the host path and on-disk spelling.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { OrchestrationV2AppThreadLineage, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { existingWorkspacePath, resolveWorkspacePath } from "./workspaceLease.ts";
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
export const ReleaseRequest = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  worktreePath: Schema.String,
  branch: Schema.String,
  family: Schema.optional(Schema.Array(ReleaseMember)),
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
export const worktreeReleaseName = (cwd: string) =>
  NodeCrypto.createHash("sha256").update(cwd).digest("hex") + ".json";
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

export const readReleaseFile = Effect.fn("WorktreeRelease.readFile")(
  function* (file: string, expectedCheckout?: string) {
    const contents = yield* Effect.tryPromise(async () => {
      const before = await NodeFSP.lstat(file, { bigint: true }).catch(missingSetupPath);
      if (!before) return null;
      if (!before.isFile() || before.ino === 0n || before.size > 1024n * 1024n)
        throw new Error("Invalid release receipt file");
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
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, bytesRead),
        );
      } finally {
        await handle.close();
      }
    });
    if (contents === null) return null;
    const request = yield* decodeReleaseRequest(contents);
    if (expectedCheckout !== undefined && request.worktreePath !== expectedCheckout)
      return yield* new WorktreeReleaseReceiptError({ receipt: file });
    return { contents, request };
  },
  Effect.timeout("5 seconds"),
  (effect, file) =>
    effect.pipe(Effect.mapError(() => new WorktreeReleaseReceiptError({ receipt: file }))),
);

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

export const familyReservesWorktree = Effect.fn("WorktreeRelease.familyReservesWorktree")(
  function* (fs: FileSystem.FileSystem, directory: string, cwd: string) {
    if (!(yield* fs.exists(directory))) return false;
    const canonical = yield* releaseReceiptPath(cwd);
    const base = releaseFile(yield* existingWorkspacePath(directory), canonical);
    for (const stage of ["", ...releaseStages]) {
      const file = base + stage;
      if (
        yield* readReleaseFile(file, canonical).pipe(
          Effect.map((loaded) => loaded?.request.family !== undefined),
          Effect.orElseSucceed(() => true),
        )
      )
        return true;
    }
    return false;
  },
);
