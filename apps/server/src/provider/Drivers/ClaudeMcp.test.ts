import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { claudeMcpServerEntry, claudeMcpServers, makeClaudeMcpManagement } from "./ClaudeMcp.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

// What `mcpServerStatus()` reports for each kind of server Claude 2.1 loads.
const statuses: ReadonlyArray<McpServerStatus> = [
  {
    name: "minions",
    status: "needs-auth",
    scope: "user",
    source: "user",
    config: { type: "http", url: "https://minions.example/api/mcp?token=secret" },
  },
  {
    name: "threadpage",
    status: "connected",
    scope: "user",
    source: "user",
    config: { type: "http", url: "https://thread.page/mcp" },
    tools: [{ name: "search" }, { name: "get_note" }],
  },
  {
    name: "github",
    status: "connected",
    scope: "user",
    source: "user",
    config: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer token" },
    },
    tools: [],
  },
  {
    name: "plugin:engineering:slack",
    status: "needs-auth",
    scope: "dynamic",
    source: "plugin",
    config: { type: "http", url: "https://mcp.slack.com/mcp" },
  },
  {
    name: "claude.ai Claude Docs",
    status: "needs-auth",
    scope: "claudeai",
    source: "claudeai",
    config: { type: "claudeai-proxy", url: "https://api.anthropic.com", id: "srv_1" },
  },
  {
    name: "repo-tools",
    status: "failed",
    scope: "local",
    source: "local",
    config: { command: "repo-tools", args: ["--stdio"] },
    error: "spawn repo-tools ENOENT\n",
  },
  { name: "slow", status: "pending", scope: "user", config: { command: "slow" } },
  {
    name: "plugin:engineering:gmail",
    status: "failed",
    scope: "dynamic",
    source: "plugin",
    config: { type: "http", url: "" },
    error: "No URL configured for this server",
  },
  {
    name: "plugin:github:github",
    status: "failed",
    scope: "dynamic",
    source: "plugin",
    config: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
    },
    error: "Error POSTing to endpoint: bad request: Authorization header is badly formatted\n",
  },
  {
    name: "t3-code",
    status: "connected",
    scope: "dynamic",
    source: "sdk",
    config: { type: "sdk", name: "t3-code" },
  },
];

it("claudeMcpServers offers sign-in only where Claude signs in, and removal only from user config", () => {
  const byName = new Map(claudeMcpServers(statuses).map((server) => [server.name, server]));

  assert.isFalse(byName.has("t3-code"));
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
  assert.deepEqual(
    [byName.get("threadpage")?.toolCount, byName.get("threadpage")?.canSignOut],
    [2, true],
  );
  // A fixed Authorization header is not a sign-in Claude can clear.
  assert.isFalse(byName.get("github")?.canSignOut);
  assert.deepEqual(byName.get("plugin:engineering:slack"), {
    name: "plugin:engineering:slack",
    displayName: "slack",
    plugin: "engineering",
    transport: "http",
    target: "https://mcp.slack.com/mcp",
    status: "needsAuth",
    origin: "plugin",
    canSignIn: true,
    canSignOut: false,
    removable: false,
    canToggle: false,
    canEdit: false,
  });
  // claude.ai connectors sign in on claude.ai.
  assert.deepEqual(
    [byName.get("claude.ai Claude Docs")?.origin, byName.get("claude.ai Claude Docs")?.canSignIn],
    ["connector", false],
  );
  assert.deepEqual(byName.get("repo-tools"), {
    name: "repo-tools",
    transport: "stdio",
    target: "repo-tools --stdio",
    status: "failed",
    message: "spawn repo-tools ENOENT",
    origin: "config",
    canSignIn: false,
    canSignOut: false,
    removable: false,
    canToggle: false,
    canEdit: false,
  });
  assert.equal(byName.get("slow")?.status, "starting");
  // A blank slot for a claude.ai connector is not a broken server.
  assert.deepEqual(
    [
      byName.get("plugin:engineering:gmail")?.status,
      byName.get("plugin:engineering:gmail")?.message,
    ],
    [
      "notConfigured",
      "The plugin leaves its address blank. Connect the matching connector on claude.ai instead.",
    ],
  );
  assert.deepEqual(
    [
      byName.get("plugin:github:github")?.missingVariable,
      byName.get("plugin:github:github")?.message,
    ],
    [
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "Claude has no GITHUB_PERSONAL_ACCESS_TOKEN to send. Add it to this provider's environment variables.",
    ],
  );
});

it("claudeMcpServers lists a server settings.json turns off from the config Claude no longer shows", () => {
  const servers = claudeMcpServers(statuses, {
    servers: {
      threadpage: { type: "http", url: "https://thread.page/mcp" },
      quiet: {
        type: "http",
        url: "https://quiet.example/mcp?key=secret",
        oauth: { clientId: "x" },
      },
    },
    turnedOff: new Set(["quiet", "removed-elsewhere"]),
  });
  const byName = new Map(servers.map((server) => [server.name, server]));

  assert.deepEqual(byName.get("quiet"), {
    name: "quiet",
    transport: "http",
    target: "https://quiet.example/mcp",
    status: "disabled",
    origin: "config",
    canSignIn: false,
    canSignOut: false,
    removable: true,
    canToggle: true,
    canEdit: true,
  });
  assert.isFalse(byName.has("removed-elsewhere"));
  assert.equal(byName.get("threadpage")?.status, "connected");
});

it("claudeMcpServerEntry leaves out empty header and environment tables", () => {
  assert.deepEqual(
    claudeMcpServerEntry({ transport: "http", url: "https://mcp.example/mcp", headers: {} }),
    { type: "http", url: "https://mcp.example/mcp" },
  );
  assert.deepEqual(
    claudeMcpServerEntry({
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { API_KEY: "k" },
    }),
    { type: "stdio", command: "npx", args: ["-y", "server"], env: { API_KEY: "k" } },
  );
});

it.layer(NodeServices.layer)("makeClaudeMcpManagement", (it) => {
  it.effect("edits a user server in place and turns it off through settings.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" }),
      );
      const configPath = path.join(root, ".claude.json");
      const settingsPath = path.join(root, ".claude", "settings.json");
      yield* fs.makeDirectory(path.dirname(settingsPath));
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({
          numStartups: 3,
          mcpServers: {
            docs: {
              type: "http",
              url: "https://docs.example/mcp",
              headers: { Authorization: "Bearer old" },
              oauth: { clientId: "kept" },
            },
            tools: { command: "tools", args: [] },
          },
        }),
      );
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({ deniedMcpServers: [{ serverUrl: "https://*.blocked.example/*" }] }),
      );
      const mcp = yield* makeClaudeMcpManagement({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        binaryPath: "claude",
        environment: {},
        cwd: root,
        configPath,
        settingsPath,
      });
      const readJson = (file: string) =>
        fs.readFileString(file).pipe(Effect.map((text): unknown => JSON.parse(text)));

      yield* mcp.edit("docs", {
        transport: "http",
        url: "https://docs.example/v2/mcp",
        headers: { Authorization: "Bearer new" },
      });
      yield* mcp.setEnabled("docs", false);
      yield* mcp.setEnabled("docs", false);
      const missing = yield* mcp.setEnabled("elsewhere", false).pipe(Effect.flip);

      assert.deepEqual(yield* readJson(configPath), {
        numStartups: 3,
        mcpServers: {
          docs: {
            type: "http",
            url: "https://docs.example/v2/mcp",
            headers: { Authorization: "Bearer new" },
            oauth: { clientId: "kept" },
          },
          tools: { command: "tools", args: [] },
        },
      });
      assert.deepEqual(yield* readJson(settingsPath), {
        deniedMcpServers: [{ serverUrl: "https://*.blocked.example/*" }, { serverName: "docs" }],
      });
      assert.equal(missing.message, "Claude's user config has no MCP server named elsewhere.");

      yield* mcp.setEnabled("docs", true);
      assert.deepEqual(yield* readJson(settingsPath), {
        deniedMcpServers: [{ serverUrl: "https://*.blocked.example/*" }],
      });
      assert.deepEqual(yield* mcp.read("tools"), {
        transport: "stdio",
        command: "tools",
        args: [],
        env: {},
      });
    }),
  );

  it.effect("finishes a sign-in whose address was pasted once Claude reconnects the server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-" });
      // Like Claude: a pasted address saves the token, and the server reports
      // needs-auth until the host asks for a reconnect.
      let reconnected = false;
      const reconnect = vi.fn(async (_name: string) => {
        reconnected = true;
      });
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: async () => ({}),
            mcpAuthenticate: async () => ({
              authUrl: "https://docs.example/authorize",
              requiresUserAction: true,
            }),
            mcpSubmitOAuthCallbackUrl: async () => undefined,
            reconnectMcpServer: reconnect,
            mcpServerStatus: async (): Promise<Array<McpServerStatus>> => [
              {
                name: "docs",
                status: reconnected ? "connected" : "needs-auth",
                scope: "user",
                config: { type: "http", url: "https://docs.example/mcp" },
              },
            ],
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const mcp = yield* makeClaudeMcpManagement({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        binaryPath: "claude",
        environment: {},
        cwd: root,
        configPath: path.join(root, ".claude.json"),
        settingsPath: path.join(root, "settings.json"),
      });

      const signIn = yield* mcp.signIn("docs");
      const completing = yield* signIn.completed.pipe(Effect.forkChild({ startImmediately: true }));
      yield* signIn.submitCallbackUrl("http://localhost:4567/callback?code=c&state=s");

      assert.deepEqual(reconnect.mock.calls, [["docs"]]);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(completing);
    }),
  );
});
