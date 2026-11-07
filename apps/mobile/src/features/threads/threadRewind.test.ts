import { ComposerContextId, type ChatAttachment } from "@t3tools/contracts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import { restoredRewindDraftContent } from "./threadRewind";

describe("restoredRewindDraftContent", () => {
  const sent = (id: string, type: "image" | "file", name: string, mimeType: string) =>
    ({ id, type, name, mimeType, sizeBytes: 10 }) as ChatAttachment;
  const local = (id: string, type: "image" | "file", name: string, mimeType: string) =>
    ({
      id,
      type,
      name,
      mimeType,
      sizeBytes: 10,
      fileUri: `file:///${id}`,
      ...(type === "image" ? { previewUri: `file:///${id}` } : {}),
    }) as DraftComposerAttachment;
  const chip = (contextId: string, attachmentId: string, name: string) =>
    ({
      version: 1,
      kind: "file",
      contextId: ComposerContextId.make(contextId),
      label: name,
      attachmentId,
      name,
      mimeType: "text/plain",
      sizeBytes: 10,
    }) as const;

  it("binds the message's chips to the restored files under fresh identities", () => {
    const record = chip("notes-chip", "server-notes", "notes.txt");
    let nextId = 0;
    const result = restoredRewindDraftContent({
      message: {
        text: `Read ${formatComposerContextReference(record)} please`,
        context: { version: 1, records: [record] },
        attachments: [
          sent("server-photo", "image", "photo.png", "image/png"),
          sent("server-notes", "file", "notes.txt", "text/plain"),
          sent("server-log", "file", "build.log", "text/plain"),
        ],
      },
      restored: [
        local("local-photo", "image", "photo.png", "image/png"),
        local("local-notes", "file", "notes.txt", "text/plain"),
        local("local-log", "file", "build.log", "text/plain"),
      ],
      createId: () => `fresh-${++nextId}`,
    });

    const records = result.content.context?.records ?? [];
    expect(records).toEqual([
      { ...record, contextId: ComposerContextId.make("fresh-1"), attachmentId: "local-notes" },
    ]);
    expect(
      collectComposerContextReferences(result.content.text).map((ref) => ref.contextId),
    ).toEqual(["fresh-1"]);
    expect(result.content.attachments.map((attachment) => attachment.id)).toEqual([
      "local-photo",
      "local-notes",
    ]);
    // No chip names the log, so it comes back separately to get one.
    expect(result.unreferencedFiles.map((attachment) => attachment.id)).toEqual(["local-log"]);
  });

  it("restores an attachment-only message with an empty prompt", () => {
    const result = restoredRewindDraftContent({
      message: {
        text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        attachments: [sent("server-photo", "image", "photo.png", "image/png")],
      },
      restored: [local("local-photo", "image", "photo.png", "image/png")],
      createId: () => "unused",
    });
    expect(result.content).toEqual({
      text: "",
      attachments: [local("local-photo", "image", "photo.png", "image/png")],
    });
  });
});
