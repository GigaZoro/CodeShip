import { describe, expect, it } from "vite-plus/test";

import { readMcpServerForm, splitCommandLine, type McpServerForm } from "./mcpServerForm";

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
  it("splits pasted command lines on spaces outside quotes", () => {
    expect(splitCommandLine(`npx -y "@scope/server name" --root 'C:\\My Files' ""`)).toEqual([
      "npx",
      "-y",
      "@scope/server name",
      "--root",
      "C:\\My Files",
      "",
    ]);
    expect(splitCommandLine(`node "unfinished`)).toBeUndefined();
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
