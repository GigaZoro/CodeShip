import { describe, expect, it } from "vite-plus/test";

import {
  mcpServerFormFromSettings,
  readMcpServerEditForm,
  readMcpServerForm,
  type McpServerForm,
} from "./mcpServerForm";

const form = (overrides: Partial<McpServerForm>): McpServerForm => ({
  name: "context7",
  kind: "local",
  url: "",
  headers: "",
  command: "",
  env: "",
  ...overrides,
});

describe("mcpServerForm", () => {
  it("opens an edit with names only and keeps the values left empty", () => {
    const stored = {
      transport: "http" as const,
      url: "https://minions.example/api",
      urlHasSecret: true,
      headerNames: ["Authorization"],
    };
    const opened = mcpServerFormFromSettings("minions", stored);
    expect(opened).toMatchObject({ kind: "remote", url: "", headers: "Authorization: " });
    expect(
      readMcpServerEditForm({ ...opened, headers: `${opened.headers}\nX-Team: acme` }, stored),
    ).toEqual({
      ok: true,
      server: { transport: "http", headers: { Authorization: "", "X-Team": "acme" } },
    });
    expect(readMcpServerEditForm({ ...opened, headers: "X-New:" }, stored)).toEqual({
      ok: false,
      errors: { headers: "Enter a value for X-New, or remove its line." },
    });
    // A local server's variables do not carry over to a remote one.
    expect(
      readMcpServerEditForm(
        { ...opened, kind: "local", command: "server", env: "API_KEY=" },
        stored,
      ),
    ).toEqual({ ok: false, errors: { env: "Enter a value for API_KEY, or remove its line." } });
  });

  it("builds the server a provider writes to its config", () => {
    expect(
      readMcpServerForm(
        form({ command: "npx -y @upstash/context7-mcp", env: "API_KEY=k=v\n\nDEBUG = 1" }),
      ),
    ).toEqual({
      ok: true,
      name: "context7",
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { API_KEY: "k=v", DEBUG: "1" },
      },
    });
    expect(
      readMcpServerForm(
        form({
          name: "minions",
          kind: "remote",
          url: " https://minions.example/api/mcp ",
          headers: "Authorization: Bearer a:b",
        }),
      ),
    ).toEqual({
      ok: true,
      name: "minions",
      server: {
        transport: "http",
        url: "https://minions.example/api/mcp",
        headers: { Authorization: "Bearer a:b" },
      },
    });
  });

  it("names each field the provider would reject", () => {
    expect(readMcpServerForm(form({ name: "my server", command: "", env: "not a pair" }))).toEqual({
      ok: false,
      errors: {
        name: "Use only letters, numbers, hyphens, and underscores.",
        command: "Enter the command that starts the server.",
        env: "Line 1 needs a variable name, then = and its value.",
      },
    });
    expect(
      readMcpServerForm(form({ kind: "remote", url: "ftp://files.example", headers: ": x" })),
    ).toEqual({
      ok: false,
      errors: {
        url: "Enter an http:// or https:// URL.",
        headers: "Line 1 needs a header name, then : and its value.",
      },
    });
  });
});
