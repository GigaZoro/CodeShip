import { describe, expect, it } from "vite-plus/test";

import { hasShellCodeFence, runnableShellCommand } from "./shellCodeBlock.js";

describe("runnableShellCommand", () => {
  it.each([
    ["gh auth login\n", "sh"],
    // Mobile's native code block tap reports the code without the fence's newline.
    ["gh auth login", "sh"],
    ["  gh auth login  ", "powershell"],
  ])("runs %j tagged %s", (code, language) => {
    expect(runnableShellCommand(code, language)).toBe("gh auth login");
  });

  it.each([
    ["gh auth login", "console"],
    ["gh auth login", ""],
    ["echo one\necho two", "bash"],
    ["echo hello\n\n", "bash"],
    ["echo hello \\", "bash"],
    ["echo safe \u202e#", "bash"],
    ["   ", "sh"],
  ])("refuses %j tagged %s", (code, language) => {
    expect(runnableShellCommand(code, language)).toBeNull();
  });
});

describe("hasShellCodeFence", () => {
  it.each([
    "```sh\ngh auth login\n```",
    "~~~bash\nls\n~~~",
    "> ```zsh\n> ls\n> ```",
    "- x\n\n  ```pwsh\r\n  ls\r\n  ```",
  ])("finds a shell fence in %j", (markdown) => {
    expect(hasShellCodeFence(markdown)).toBe(true);
  });

  it.each([
    "```ts\nconst x = 1;\n```",
    "Run `gh auth login` first.",
    "```shell-session\n$ ls\n```",
  ])("finds none in %j", (markdown) => {
    expect(hasShellCodeFence(markdown)).toBe(false);
  });
});
