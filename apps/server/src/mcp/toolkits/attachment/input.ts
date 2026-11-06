import { ChatAttachmentId, ChatFileAttachment, ChatImageAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Last in the union: a full attachment also carries an `id`.
const StoredAttachmentReference = Schema.Struct({ id: ChatAttachmentId }).annotate({
  description:
    "An attachment in your thread or one that delegated to it, copied over. `id`: its saved file name without the extension.",
});

// Keep screenshot provenance in app metadata; its recursive tree breaks model tool schemas.
export const McpAttachmentInput = Schema.Union([
  ChatImageAttachment.mapFields(Struct.omit(["source"])),
  ChatFileAttachment,
  StoredAttachmentReference,
]);
export type McpAttachmentInput = typeof McpAttachmentInput.Type;
