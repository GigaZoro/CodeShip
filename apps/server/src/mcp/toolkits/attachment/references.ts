import {
  type ChatAttachment,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import { type Caller, unavailable } from "../../threadAccess.ts";
import type { McpAttachmentInput } from "./input.ts";

const MAX_DELEGATION_DEPTH = 8;

const isFullAttachment = (attachment: McpAttachmentInput): attachment is ChatAttachment =>
  "type" in attachment;

const invalid = (message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));

interface ResolvedAttachment {
  readonly attachment: ChatAttachment;
  /** Stored on another thread, so the send copies it in. */
  readonly forward: boolean;
}

/**
 * A pending upload goes as given. Anything else takes its stored record, so a caller cannot
 * relabel a file: the target thread's own is reused, and one the caller can see is forwarded.
 */
export function resolveAttachmentReferences(
  requested: ReadonlyArray<McpAttachmentInput>,
  owned: ReadonlyArray<ChatAttachment>,
  visible: ReadonlyArray<ChatAttachment> = [],
) {
  if (new Set(requested.map((attachment) => attachment.id)).size !== requested.length)
    return invalid("Duplicate attachment ids are not allowed.");
  const ownedById = new Map(owned.map((attachment) => [attachment.id, attachment]));
  const visibleById = new Map(visible.map((attachment) => [attachment.id, attachment]));
  return Effect.forEach(
    requested,
    (attachment): Effect.Effect<ResolvedAttachment, OrchestratorMcpFailure> => {
      if (Claims.attachmentIsPendingUpload(attachment))
        return isFullAttachment(attachment)
          ? Effect.succeed({ attachment, forward: false })
          : invalid("Pass a pending upload with its type, name, mimeType and sizeBytes.");
      const stored = ownedById.get(attachment.id);
      if (stored !== undefined) return Effect.succeed({ attachment: stored, forward: false });
      const visibleRecord = visibleById.get(attachment.id);
      return visibleRecord === undefined
        ? invalid(
            "An attachment must be a pending upload, belong to the target thread, or be on a message in your thread or a thread that delegated to yours.",
          )
        : Effect.succeed({ attachment: visibleRecord, forward: true });
    },
  );
}

/** Attachments on the messages of the caller's thread and of the threads that delegated to it. */
const callerVisibleAttachments = Effect.fn("mcp.callerVisibleAttachments")(function* (
  context: Pick<Caller, "caller" | "threads">,
) {
  if (context.caller === undefined) return [];
  const threadIds: ThreadId[] = [context.caller.id];
  let shell: OrchestrationV2ThreadShell = context.caller;
  while (
    threadIds.length < MAX_DELEGATION_DEPTH &&
    shell.lineage.relationshipToParent === "subagent" &&
    shell.lineage.parentThreadId !== null
  ) {
    const parent = yield* context.threads
      .getThreadShell(shell.lineage.parentThreadId)
      .pipe(Effect.mapError(unavailable));
    if (parent === null || parent.deletedAt !== null) break;
    threadIds.push(parent.id);
    shell = parent;
  }
  const records = yield* Effect.forEach(threadIds, (threadId) =>
    context.threads.getThreadRecords(threadId, ["messages"]).pipe(Effect.mapError(unavailable)),
  );
  return records.flatMap((record) => record.messages.flatMap((message) => message.attachments));
});

/**
 * Resolves a tool's attachments, copies forwarded ones in as pending uploads, and runs `send`
 * with them. The staged copies go once the send settles; its claim made the thread's own copies.
 */
export const withResolvedAttachments = Effect.fn("mcp.withResolvedAttachments")(function* <A, E, R>(
  input: {
    readonly requested: ReadonlyArray<McpAttachmentInput>;
    readonly owned: ReadonlyArray<ChatAttachment>;
    readonly context: Pick<Caller, "caller" | "threads">;
  },
  send: (attachments: ReadonlyArray<ChatAttachment>) => Effect.Effect<A, E, R>,
) {
  const ownedIds = new Set(input.owned.map((attachment) => attachment.id));
  const needsVisible = input.requested.some(
    (attachment) => !ownedIds.has(attachment.id) && !Claims.attachmentIsPendingUpload(attachment),
  );
  const resolved = yield* resolveAttachmentReferences(
    input.requested,
    input.owned,
    needsVisible ? yield* callerVisibleAttachments(input.context) : [],
  );
  if (!resolved.some((entry) => entry.forward))
    return yield* send(resolved.map((entry) => entry.attachment));
  const staged = yield* Claims.stageAttachmentCopies(resolved).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
    ),
  );
  return yield* send(staged.attachments).pipe(
    Effect.ensuring(Claims.releaseClaimedAttachments(staged.stagedPaths)),
  );
});
