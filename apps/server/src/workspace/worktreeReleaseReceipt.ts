// @effect-diagnostics nodeBuiltinImport:off -- Receipt keys use the host path and on-disk spelling.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { OrchestrationV2AppThreadLineage, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { existingWorkspacePath, resolveWorkspacePath } from "./workspaceLease.ts";

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

export const readReleaseFile = Effect.fn("WorktreeRelease.readFile")(
  function* (fs: FileSystem.FileSystem, file: string) {
    if ((yield* existingWorkspacePath(file)) !== file) return null;
    const stat = yield* fs.stat(file);
    if (stat.type !== "File" || stat.size > 128n * 1024n) return null;
    return yield* decodeReleaseRequest(yield* fs.readFileString(file));
  },
  Effect.timeout("5 seconds"),
  Effect.orElseSucceed(() => null),
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
      if (!(yield* directoryEntryExists(file))) continue;
      const request = yield* readReleaseFile(fs, file);
      if (!request || request.worktreePath !== canonical || request.family !== undefined)
        return true;
    }
    return false;
  },
);
