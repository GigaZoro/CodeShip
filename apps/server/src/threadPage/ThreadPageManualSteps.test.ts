import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import * as Settings from "../serverSettings.ts";
import * as ThreadPageManualSteps from "./ThreadPageManualSteps.ts";

const INBOX = "inbox";
const folders = [
  { id: "work", name: "Agent Maintenance", parent_id: null, trashed: false },
  { id: INBOX, name: "Machine inbox", parent_id: "work", trashed: false },
  { id: "mac", name: "MacBook-Pro", parent_id: INBOX, trashed: false },
  { id: "vps", name: "Zoro-VPS", parent_id: INBOX, trashed: false },
  { id: "mac-old", name: "Older", parent_id: "mac", trashed: false },
  { id: "gone", name: "Retired", parent_id: INBOX, trashed: true },
  { id: "codeship", name: "CodeShip", parent_id: null, trashed: false },
];
const thread = (
  id: string,
  fields: { status?: string; description?: string; title?: string; archived?: boolean } = {},
) => ({
  id,
  title: fields.title ?? `Thread ${id}`,
  description: fields.description ?? "",
  status: fields.status ?? "waiting",
  archived: fields.archived ?? false,
  trashed: false,
  last_activity_at: "2026-11-07T21:41:11.934Z",
});
const threadsByFolder: Record<string, ReadonlyArray<ReturnType<typeof thread>>> = {
  mac: [
    thread("minions", {
      title: "Hands-on: sign in to the minions MCP server",
      description: "Hands-on: run `claude mcp login minions`\non this Mac.",
    }),
    thread("active", { status: "active", description: "Working: agent run" }),
    thread("done", { status: "done", description: "Done 2026-11-07" }),
    thread("archived", { archived: true, description: "Hands-on: old" }),
  ],
  "mac-old": [thread("nested", { description: "No prefix here" })],
  vps: [
    thread("contabo", {
      title: "Finish the open Zoro-VPS setup steps",
      description: "Needs you: the Contabo contract term. Hands-on: then reboot.",
    }),
  ],
  gone: [thread("trashed-folder")],
  codeship: [thread("outside-inbox", { description: "Hands-on: not a machine list" })],
};

function fakeThreadPage(
  options: { status?: number; headers?: Record<string, string>; noInbox?: boolean } = {},
) {
  const requests: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer tp_test");
      const url = new URL(request.url);
      const params = new URLSearchParams(UrlParams.toString(request.urlParams));
      requests.push(`${url.pathname.replace("/api/integrations/v1", "")}?${params}`);
      if (options.status !== undefined) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { code: "x" },
            { status: options.status, ...(options.headers ? { headers: options.headers } : {}) },
          ),
        );
      }
      if (url.pathname.endsWith("/folders") && options.noInbox === true) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            items: folders.filter((folder) => folder.id !== INBOX),
            next_cursor: null,
          }),
        );
      }
      if (url.pathname.endsWith("/folders")) {
        // Two pages, so the inbox and its folders arrive on different pages.
        const cursor = params.get("cursor");
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            cursor === null
              ? { items: folders.slice(0, 3), next_cursor: "page-2" }
              : { items: folders.slice(3), next_cursor: null },
          ),
        );
      }
      const folderId = params.get("folder_id") ?? "";
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ items: threadsByFolder[folderId] ?? [], next_cursor: null }),
      );
    }),
  );
  return { requests, http };
}

const listWith = (http: HttpClient.HttpClient, apiToken = "tp_test") =>
  Effect.gen(function* () {
    const service = yield* ThreadPageManualSteps.ThreadPageManualSteps;
    return yield* service.list;
  }).pipe(
    Effect.provide(
      ThreadPageManualSteps.layer.pipe(
        Layer.provide(Settings.ServerSettingsService.layerTest({ threadPage: { apiToken } })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.orDie,
      ),
    ),
  );

describe("ThreadPageManualSteps", () => {
  it.effect("lists the Waiting threads of every machine folder, prefixes removed", () =>
    Effect.gen(function* () {
      const { http, requests } = fakeThreadPage();
      const result = yield* listWith(http);
      assert(result._tag === "Listed");
      expect(
        [...result.steps]
          .sort((left, right) => left.threadId.localeCompare(right.threadId))
          .map(({ threadId, kind, machine, step, title }) => ({
            threadId,
            kind,
            machine,
            step,
            title,
          })),
      ).toEqual([
        {
          threadId: "contabo",
          kind: "needs-you",
          machine: "Zoro-VPS",
          step: "the Contabo contract term. Hands-on: then reboot.",
          title: "Finish the open Zoro-VPS setup steps",
        },
        {
          threadId: "minions",
          kind: "hands-on",
          machine: "MacBook-Pro",
          step: "run `claude mcp login minions` on this Mac.",
          title: "sign in to the minions MCP server",
        },
        {
          threadId: "nested",
          kind: "hands-on",
          machine: "MacBook-Pro",
          step: "No prefix here",
          title: "Thread nested",
        },
      ]);
      expect(result.steps.find((step) => step.threadId === "minions")?.url).toBe(
        "https://thread.page/app/threads/minions",
      );
      // Only machine folders are listed, never the trashed one or folders outside the inbox.
      expect(
        requests
          .filter((path) => path.startsWith("/threads"))
          .map((path) => new URLSearchParams(path.split("?")[1]).get("folder_id"))
          .sort(),
      ).toEqual(["mac", "mac-old", "vps"]);
    }),
  );

  it.effect("reports a server without a token as not connected, without calling ThreadPage", () =>
    Effect.gen(function* () {
      const { http, requests } = fakeThreadPage();
      expect(yield* listWith(http, "")).toEqual({ _tag: "NotConnected" });
      expect(requests).toEqual([]);
    }),
  );

  it.effect("names why ThreadPage refused the read", () =>
    Effect.gen(function* () {
      const cases = [
        [{ status: 401 }, "token-rejected"],
        [{ status: 403 }, "access-denied"],
        [{ status: 409 }, "paused"],
        [{ status: 429, headers: { "retry-after": "30" } }, "rate-limited"],
        [{ status: 503 }, "unreachable"],
      ] as const;
      for (const [response, reason] of cases) {
        const error = yield* listWith(fakeThreadPage(response).http).pipe(Effect.flip);
        expect(error.reason).toBe(reason);
        expect(error.detail).not.toContain("tp_test");
      }
      const missing = yield* listWith(fakeThreadPage({ noInbox: true }).http).pipe(Effect.flip);
      expect(missing.reason).toBe("no-inbox");
    }),
  );
});
