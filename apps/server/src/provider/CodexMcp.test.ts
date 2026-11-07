import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";

import { codexConfiguredMcpServers, codexMcpServers, makeCodexMcpManagement } from "./CodexMcp.ts";

type Status = CodexSchema.V2ListMcpServerStatusResponse["data"][number];

const status = (overrides: Partial<Status> & Pick<Status, "name" | "authStatus">): Status => ({
  resourceTemplates: [],
  resources: [],
  tools: {},
  ...overrides,
});

const tool = (name: string) => ({ name, inputSchema: {} });

const userLayer = { name: { type: "user", file: "/home/me/.codex/config.toml" }, version: "v1" };
const managedLayer = {
  name: { type: "mdm", domain: "com.openai.codex", key: "config" },
  version: "v1",
};

// The shapes Codex 0.166 answers `config/read` and `mcpServerStatus/list` with.
const configRead = {
  config: {
    mcp_servers: {
      minions: { url: "https://minions.example/api/mcp?key=secret", enabled: true },
      threadpage: { url: "https://thread.page/mcp", enabled: true },
      "computer-use": { command: "./Computer Use", args: ["mcp"], enabled: false },
      node_repl: {
        command: "node_repl",
        args: [],
        env: { TOKEN: "x" },
        cwd: "/home/user",
        startup_timeout_sec: 20,
        enabled: true,
      },
      policy: { url: "https://policy.example/mcp", enabled: true },
      silent: { command: "silent-server", enabled: true },
    },
  },
  origins: {
    "mcp_servers.minions.url": userLayer,
    "mcp_servers.threadpage.url": userLayer,
    "mcp_servers.computer-use.command": userLayer,
    "mcp_servers.node_repl.command": userLayer,
    "mcp_servers.policy.url": managedLayer,
    "mcp_servers.silent.command": userLayer,
  },
} as unknown as CodexSchema.V2ConfigReadResponse;

const statuses: ReadonlyArray<Status> = [
  status({
    name: "minions",
    authStatus: "notLoggedIn",
    httpOrigin: "https://minions.example",
    toolsError: "MCP startup failed: handshaking with MCP server failed",
  }),
  status({
    name: "threadpage",
    authStatus: "oAuth",
    tools: { search: tool("search"), get_note: tool("get_note") },
  }),
  status({ name: "computer-use", authStatus: "unsupported" }),
  status({ name: "node_repl", authStatus: "unsupported", toolsError: "spawn failed\nENOENT" }),
  status({ name: "policy", authStatus: "bearerToken", tools: { a: tool("a") } }),
  status({
    name: "cua_repl",
    authStatus: "unsupported",
    pluginId: "unified-computer-use@openai-bundled",
    tools: { click: tool("click") },
  }),
  status({
    name: "codex_apps",
    authStatus: "bearerToken",
    httpOrigin: "https://chatgpt.com",
    tools: { gmail: tool("gmail") },
  }),
];

it("codexMcpServers reads config for what a server is and status for whether it works", () => {
  const servers = codexMcpServers(codexConfiguredMcpServers(configRead), statuses);
  const byName = new Map(servers.map((server) => [server.name, server]));

  assert.deepEqual(byName.get("minions"), {
    name: "minions",
    transport: "http",
    target: "https://minions.example/api/mcp",
    status: "needsAuth",
    origin: "config",
    canSignIn: true,
    canSignOut: false,
    removable: true,
    canToggle: true,
    canEdit: true,
  });
  assert.deepEqual(byName.get("threadpage"), {
    name: "threadpage",
    transport: "http",
    target: "https://thread.page/mcp",
    status: "connected",
    toolCount: 2,
    origin: "config",
    canSignIn: false,
    canSignOut: true,
    removable: true,
    canToggle: true,
    canEdit: true,
  });
  assert.equal(byName.get("computer-use")?.status, "disabled");
  assert.equal(byName.get("computer-use")?.target, "./Computer Use mcp");
  assert.deepEqual(
    [byName.get("node_repl")?.status, byName.get("node_repl")?.message],
    ["failed", "ENOENT"],
  );
  assert.deepEqual(
    [
      byName.get("policy")?.origin,
      byName.get("policy")?.removable,
      byName.get("policy")?.canToggle,
      byName.get("policy")?.canEdit,
    ],
    ["managed", false, false, false],
  );
  assert.deepEqual(
    [byName.get("silent")?.status, byName.get("silent")?.message],
    ["failed", "Codex did not report this server."],
  );
  assert.deepEqual(byName.get("cua_repl"), {
    name: "cua_repl",
    status: "connected",
    toolCount: 1,
    origin: "plugin",
    plugin: "unified-computer-use",
    canSignIn: false,
    canSignOut: false,
    removable: false,
    canToggle: false,
    canEdit: false,
  });
  assert.deepEqual(
    [byName.get("codex_apps")?.origin, byName.get("codex_apps")?.target],
    ["builtIn", "https://chatgpt.com"],
  );
});

const authorizationUrl =
  "https://minions.example/oauth/authorize?response_type=code&state=s7Ate&redirect_uri=http%3A%2F%2F127.0.0.1%3A62974%2Fcallback%2Fk3y";

const makeClient = Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
  const handlers = new Map<string, (event: unknown) => Effect.Effect<void>>();
  // Only the methods MCP management calls.
  const client = {
    request: (method: string, payload: unknown) =>
      Ref.update(requests, (all) => [...all, [method, payload] as const]).pipe(
        Effect.as(
          method === "config/read"
            ? configRead
            : method === "mcpServer/oauth/login"
              ? { authorizationUrl }
              : { status: "ok" },
        ),
      ),
    handleServerNotification: (method: string, handler: (event: unknown) => Effect.Effect<void>) =>
      Effect.sync(() => {
        handlers.set(method, handler);
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  return { client, requests, handlers };
});

it.effect("adds servers as new config tables and removes them by key", () =>
  Effect.gen(function* () {
    const { client, requests } = yield* makeClient;
    const mcp = yield* makeCodexMcpManagement({
      instanceId: ProviderInstanceId.make("codex"),
      openClient: Effect.succeed(client),
      runCli: () => Effect.die("unexpected CLI call"),
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("no http")),
      ),
    );

    yield* mcp.add("context7", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: {},
    });
    const taken = yield* mcp
      .add("minions", { transport: "http", url: "https://minions.example/mcp", headers: {} })
      .pipe(Effect.flip);
    assert.equal(taken.message, "Codex already has an MCP server named minions.");
    yield* mcp.remove("threadpage");
    const odd = yield* mcp.remove("claude.ai Notion").pipe(Effect.flip);
    assert.equal(odd.operation, "remove");

    const writes = (yield* Ref.get(requests)).filter(([method]) => method === "config/value/write");
    assert.deepEqual(writes, [
      [
        "config/value/write",
        {
          keyPath: "mcp_servers",
          value: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
          mergeStrategy: "upsert",
        },
      ],
      [
        "config/value/write",
        { keyPath: "mcp_servers.threadpage", value: null, mergeStrategy: "replace" },
      ],
    ]);
  }),
);

it.effect(
  "edits a server in one write that keeps its other settings, and turns it off by key",
  () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeClient;
      const mcp = yield* makeCodexMcpManagement({
        instanceId: ProviderInstanceId.make("codex"),
        openClient: Effect.succeed(client),
        runCli: () => Effect.die("unexpected CLI call"),
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no http")),
        ),
      );

      assert.deepEqual(yield* mcp.read("node_repl"), {
        transport: "stdio",
        command: "node_repl",
        args: [],
        env: { TOKEN: "x" },
      });
      // A local server that becomes remote loses its command's settings, not its timeout.
      yield* mcp.edit("node_repl", {
        transport: "http",
        url: "https://repl.example/mcp",
        headers: {},
      });
      yield* mcp.edit("minions", {
        transport: "http",
        url: "https://minions.example/v2/mcp",
        headers: { "X-Team": "acme" },
      });
      yield* mcp.setEnabled("threadpage", false);
      const managed = yield* mcp.setEnabled("policy", false).pipe(Effect.flip);
      assert.equal(managed.message, "Change this server in config.toml by hand.");

      const writes = (yield* Ref.get(requests)).filter(
        ([method]) => method === "config/batchWrite" || method === "config/value/write",
      );
      assert.deepEqual(writes, [
        [
          "config/batchWrite",
          {
            edits: [
              {
                keyPath: "mcp_servers.node_repl.url",
                value: "https://repl.example/mcp",
                mergeStrategy: "replace",
              },
              { keyPath: "mcp_servers.node_repl.command", value: null, mergeStrategy: "replace" },
              { keyPath: "mcp_servers.node_repl.args", value: null, mergeStrategy: "replace" },
              { keyPath: "mcp_servers.node_repl.env", value: null, mergeStrategy: "replace" },
              { keyPath: "mcp_servers.node_repl.cwd", value: null, mergeStrategy: "replace" },
            ],
          },
        ],
        [
          "config/batchWrite",
          {
            edits: [
              {
                keyPath: "mcp_servers.minions.url",
                value: "https://minions.example/v2/mcp",
                mergeStrategy: "replace",
              },
              {
                keyPath: "mcp_servers.minions.http_headers",
                value: { "X-Team": "acme" },
                mergeStrategy: "replace",
              },
            ],
          },
        ],
        [
          "config/value/write",
          { keyPath: "mcp_servers.threadpage.enabled", value: false, mergeStrategy: "replace" },
        ],
      ]);
    }),
);

it.effect("signs in through the app server and forwards a pasted callback to its page", () =>
  Effect.gen(function* () {
    const { client, requests, handlers } = yield* makeClient;
    const forwarded = yield* Ref.make<ReadonlyArray<string>>([]);
    const http = HttpClient.make((request) =>
      Ref.update(forwarded, (urls) => [...urls, request.url]).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response("ok"))),
      ),
    );
    const mcp = yield* makeCodexMcpManagement({
      instanceId: ProviderInstanceId.make("codex"),
      openClient: Effect.succeed(client),
      runCli: () => Effect.die("unexpected CLI call"),
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));

    yield* Effect.gen(function* () {
      const signIn = yield* mcp.signIn("minions");
      assert.equal(signIn.authorizationUrl, authorizationUrl);

      const foreign = yield* signIn
        .submitCallbackUrl("http://127.0.0.1:62974/callback/k3y?code=abc&state=forged")
        .pipe(Effect.flip);
      assert.equal(foreign.message, "This address does not belong to the current sign-in.");
      yield* signIn.submitCallbackUrl("http://127.0.0.1:62974/callback/k3y?code=abc&state=s7Ate");
      assert.deepEqual(yield* Ref.get(forwarded), [
        "http://127.0.0.1:62974/callback/k3y?code=abc&state=s7Ate",
      ]);

      const completed = handlers.get("mcpServer/oauthLogin/completed");
      assert.isDefined(completed);
      yield* completed!({ name: "other", success: false, error: "not this one" });
      yield* completed!({ name: "minions", success: true });
      yield* signIn.completed;
    }).pipe(Effect.scoped);

    assert.deepEqual(
      (yield* Ref.get(requests)).find(([method]) => method === "mcpServer/oauth/login"),
      ["mcpServer/oauth/login", { name: "minions", timeoutSecs: 300 }],
    );
  }),
);
