import { assert, it } from "@effect/vitest";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";

import { claudeMcpServerJson, claudeMcpServers } from "./ClaudeMcp.ts";

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
  });
  assert.equal(byName.get("slow")?.status, "starting");
});

it("claudeMcpServerJson leaves out empty header and environment tables", () => {
  assert.deepEqual(
    JSON.parse(
      claudeMcpServerJson({ transport: "http", url: "https://mcp.example/mcp", headers: {} }),
    ),
    { type: "http", url: "https://mcp.example/mcp" },
  );
  assert.deepEqual(
    JSON.parse(
      claudeMcpServerJson({
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
        env: { API_KEY: "k" },
      }),
    ),
    { type: "stdio", command: "npx", args: ["-y", "server"], env: { API_KEY: "k" } },
  );
});
