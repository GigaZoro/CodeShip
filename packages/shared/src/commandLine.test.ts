import { describe, expect, it } from "vite-plus/test";

import { joinCommandLine, splitCommandLine, splitQuotedCommandLine } from "./commandLine.ts";

describe("commandLine", () => {
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
    const words = ["npx", "@scope/server name", "C:\\dir\\", `say "hi"`, "it's", ""];
    expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
  });

  it("keeps the part of each word that was outside quotes", () => {
    expect(splitQuotedCommandLine(`a "~/My Dir"/x '|' | "a"|b`)).toEqual([
      { text: "a", outsideQuotes: "a" },
      { text: "~/My Dir/x", outsideQuotes: "/x" },
      { text: "|", outsideQuotes: "" },
      { text: "|", outsideQuotes: "|" },
      { text: "a|b", outsideQuotes: "|b" },
    ]);
  });
});
