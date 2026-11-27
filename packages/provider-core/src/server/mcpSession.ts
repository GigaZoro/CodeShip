// @effect-diagnostics nodeBuiltinImport:off -- adapters build review evidence synchronously from native reports.
import * as NodeCrypto from "node:crypto";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** Present only for a restricted reviewer: the adapter must run it as `ReviewAssignmentSession` says. */
  readonly reviewAssignment?: ReviewAssignmentSession;
}

/** Tools a restricted reviewer's endpoint serves; the adapters refuse a session that shows any other. */
export const REVIEW_ASSIGNMENT_TOOL = "read_material";
/** The MCP server name the adapter registers the assignment endpoint under. */
export const REVIEW_ASSIGNMENT_MCP_SERVER = "t3-review-assignment";

export interface ReviewAssignmentSessionEvidence {
  readonly runId: string;
  readonly driver: "claudeAgent";
  readonly nativeAccount: string;
  readonly model: string;
  readonly effort: string | null;
  readonly effectiveTools: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
  readonly cwd: string;
  readonly instructionDigest: string;
  readonly promptDigest: string;
}

/**
 * A restricted review session runs in `cwd`, an empty directory outside every checkout, and has
 * no tool but `read_material` on this config's endpoint. The adapter calls `attest` with what the
 * native session reports before it sends the first prompt; a failure ends the turn uninferred.
 */
export interface ReviewAssignmentSession {
  readonly handle: string;
  readonly cwd: string;
  readonly attest: (
    evidence: ReviewAssignmentSessionEvidence,
  ) => Effect.Effect<void, ReviewAssignmentRefusedError>;
}

/** Hex SHA-256 of a value's canonical JSON: the digest form review evidence carries. */
export function reviewEvidenceDigest(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export class ReviewAssignmentRefusedError extends Schema.TaggedError<ReviewAssignmentRefusedError>()(
  "ReviewAssignmentRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Restricted review refused before inference: ${this.reason}`;
  }
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
