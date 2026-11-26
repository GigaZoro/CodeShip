import { parse } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";

import { codexExecArgsWithoutMcp } from "./codexStockMcpArgs.ts";

describe("codexExecArgsWithoutMcp", () => {
  it("preserves individual CLI transports, raw string fallbacks and feature flags", () => {
    const launch = [
      "-c",
      "mcp_servers.docs.command=my-server",
      "--config=mcp_servers.docs.args=['--query=x']",
      "-c=mcp_servers.docs.enabled=true",
      "--disable",
      "apps",
    ];
    expect(codexExecArgsWithoutMcp(launch, ["docs"])).toEqual([
      ...launch,
      "--config",
      "mcp_servers.docs.enabled=false",
    ]);
  });

  it("only changes the final whole-table override and keeps dotted names literal", () => {
    const before = ["--config", 'mcp_servers={"docs.internal"={command="discarded"}}'];
    const after = ["-c", "mcp_servers.docs.command=new-command", "--strict-config"];
    const table = [
      '"docs.internal"={url="https://example.test",enabled=true,http_headers={X="a=b"}}',
      'docs={command="before",args=["--debug"]}',
      '"constructor.name"={command="tool"}',
      '__proto__={command="own-property"}',
    ].join(",");
    for (const flag of ["-c", "--config", "-c=", "--config="]) {
      const value = " mcp_servers = {" + table + "}";
      const root = flag.endsWith("=") ? [flag + value] : [flag, value];
      const args = codexExecArgsWithoutMcp(
        [...before, ...root, ...after],
        ["docs.internal", "docs", "constructor.name", "file.only"],
      );
      expect(args.slice(0, before.length)).toEqual(before);
      const replacement = args[before.length + root.length - 1]!.replace(/^(--config=|-c=)/, "");
      expect(parse(replacement).mcp_servers).toEqual({
        "docs.internal": {
          url: "https://example.test",
          enabled: false,
          http_headers: { X: "a=b" },
        },
        docs: { command: "before", args: ["--debug"] },
        "constructor.name": { command: "tool", enabled: false },
        ["__proto__"]: { command: "own-property" },
        "file.only": { enabled: false },
      });
      expect(args.slice(before.length + root.length)).toEqual([
        ...after,
        "--config",
        "mcp_servers.docs.enabled=false",
      ]);
    }
  });

  it("adds only switches for file settings alongside an individual transport override", () => {
    const launch = ["-c", "mcp_servers.docs.command=cli", "--enable=plugins"];
    const args = codexExecArgsWithoutMcp(launch, ["file.name", "odd=name", "docs"]);
    expect(args[0]).toBe("--config");
    expect(parse(args[1]!).mcp_servers).toEqual({
      "file.name": { enabled: false },
      "odd=name": { enabled: false },
    });
    expect(args.slice(2)).toEqual([...launch, "--config", "mcp_servers.docs.enabled=false"]);
  });

  it("passes through the launch when discovery found no enabled servers", () => {
    const launch = ["--enable", "plugins", "--config", "mcp_servers.docs.enabled=false"];
    expect(codexExecArgsWithoutMcp(launch, [])).toEqual(launch);
  });

  it("keeps nested overrides after a whole-table scalar that Codex replaced", () => {
    const launch = ["-c", "mcp_servers=raw-value", "-c", "mcp_servers.docs.command=real-command"];
    const args = codexExecArgsWithoutMcp(launch, ["file.docs", "docs"]);
    expect(parse(args[1]!).mcp_servers).toEqual({ "file.docs": { enabled: false } });
    expect(args.slice(2)).toEqual([
      ...launch.slice(2),
      "--config",
      "mcp_servers.docs.enabled=false",
    ]);
  });
});
