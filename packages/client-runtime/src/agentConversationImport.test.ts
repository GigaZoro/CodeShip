import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { conversationImportNotice } from "./agentConversationImport.ts";
import { scopeThreadRef } from "./environment/scoped.ts";

const mac = EnvironmentId.make("mac");
const vps = EnvironmentId.make("vps");

const imported = (
  environmentId: EnvironmentId,
  label: string,
  importedCount: number,
  latest: { readonly threadId: string; readonly updatedAt: string } | null,
  complete = true,
) => ({
  environmentId,
  label,
  result: {
    importedCount,
    latestThread: latest && {
      threadId: ThreadId.make(latest.threadId),
      updatedAt: latest.updatedAt,
    },
    complete,
  },
});

describe("conversationImportNotice", () => {
  it("counts every machine's import and points at the most recently active conversation", () => {
    expect(
      conversationImportNotice([
        imported(mac, "Mac", 1, { threadId: "older", updatedAt: "2026-11-01T00:00:00.000Z" }),
        imported(vps, "VPS", 38, { threadId: "newer", updatedAt: "2026-11-05T00:00:00.000Z" }),
      ]),
    ).toEqual({
      type: "success",
      title: "Imported 39 conversations · find them under Settled",
      thread: scopeThreadRef(vps, ThreadId.make("newer")),
    });
  });

  it("says so when the import found nothing new", () => {
    expect(conversationImportNotice([imported(mac, "Mac", 0, null)])).toEqual({
      type: "info",
      title: "No new conversations to import",
      thread: null,
    });
  });

  it("does not call a failed import empty", () => {
    expect(
      conversationImportNotice([
        imported(mac, "Mac", 0, null, false),
        { environmentId: vps, label: "VPS", error: "Disconnected" },
      ]),
    ).toEqual({
      type: "error",
      title: "Could not import conversations",
      description:
        "Some projects on Mac could not be imported.\nCould not import on VPS: Disconnected",
      thread: null,
    });
  });
});
