import { assert, it } from "@effect/vitest";

import {
  providerMcpBearerTokenError,
  providerMcpServerSettings,
  resolveProviderMcpServerEdit,
} from "./providerMcp.ts";

it("providerMcpServerSettings sends names but never stored values or a keyed address", () => {
  assert.deepEqual(
    providerMcpServerSettings({
      transport: "http",
      url: "https://mcp.example/api?token=secret",
      headers: { Authorization: "Bearer secret" },
    }),
    {
      transport: "http",
      url: "https://mcp.example/api",
      urlHasSecret: true,
      headerNames: ["Authorization"],
    },
  );
  assert.deepEqual(
    providerMcpServerSettings({ transport: "http", url: "https://mcp.example/mcp/", headers: {} }),
    { transport: "http", url: "https://mcp.example/mcp/", urlHasSecret: false, headerNames: [] },
  );
  assert.deepEqual(
    providerMcpServerSettings({
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { API_KEY: "secret" },
    }),
    { transport: "stdio", command: "npx", args: ["-y", "server"], envNames: ["API_KEY"] },
  );
});

it("resolveProviderMcpServerEdit keeps stored values for empty ones and drops names left out", () => {
  const stored = {
    transport: "http" as const,
    url: "https://mcp.example/api?token=secret",
    headers: { Authorization: "Bearer secret", "X-Team": "acme" },
  };
  assert.deepEqual(
    resolveProviderMcpServerEdit(stored, {
      transport: "http",
      headers: { Authorization: "", "X-New": "1" },
    }),
    {
      server: {
        transport: "http",
        url: "https://mcp.example/api?token=secret",
        headers: { Authorization: "Bearer secret", "X-New": "1" },
      },
    },
  );
  assert.deepEqual(
    resolveProviderMcpServerEdit(stored, { transport: "http", headers: { "X-Other": "" } }),
    { missing: "X-Other" },
  );
  // A local server has no address or headers to keep.
  assert.deepEqual(
    resolveProviderMcpServerEdit(
      { transport: "stdio", command: "server", args: [], env: { API_KEY: "secret" } },
      { transport: "http", headers: {} },
    ),
    { missing: "URL" },
  );
  assert.deepEqual(
    resolveProviderMcpServerEdit(
      { transport: "stdio", command: "server", args: [], env: { API_KEY: "secret" } },
      { transport: "stdio", command: "server", args: ["--fast"], env: { API_KEY: "" } },
    ),
    {
      server: {
        transport: "stdio",
        command: "server",
        args: ["--fast"],
        env: { API_KEY: "secret" },
      },
    },
  );
});
it("keeps the bearer variable across legacy edits and rejects conflicting authentication", () => {
  const stored = {
    transport: "http" as const,
    url: "https://notes.example/mcp",
    headers: {},
    bearerTokenEnvVar: "NOTES_TOKEN",
  };
  assert.deepEqual(resolveProviderMcpServerEdit(stored, { transport: "http", headers: {} }), {
    server: stored,
  });
  assert.deepEqual(
    resolveProviderMcpServerEdit(stored, {
      transport: "http",
      headers: {},
      bearerTokenEnvVar: null,
    }),
    { server: { transport: "http", url: stored.url, headers: {} } },
  );
  assert.isDefined(providerMcpBearerTokenError({ ...stored, url: "http://notes.example/mcp" }));
  assert.isDefined(
    providerMcpBearerTokenError({ ...stored, headers: { authorization: "Bearer conflicting" } }),
  );
  assert.isUndefined(providerMcpBearerTokenError(stored));
  assert.isDefined(
    providerMcpBearerTokenError({ ...stored, url: "https://other.example/mcp" }, stored),
  );
  assert.isUndefined(
    providerMcpBearerTokenError({ ...stored, url: "https://notes.example/mcp/v2" }, stored),
  );
});
