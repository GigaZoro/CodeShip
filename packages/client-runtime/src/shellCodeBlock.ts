const SHELL_LANGUAGES = "sh|bash|zsh|fish|shell|powershell|pwsh";
const SHELL_LANGUAGE = new RegExp(`^(?:${SHELL_LANGUAGES})$`);
const SHELL_FENCE = new RegExp(
  `^[ \\t>-]*(?:\`{3,}|~{3,})[ \\t]*(?:${SHELL_LANGUAGES})[ \\t]*\\r?$`,
  "m",
);

/** Whether a message may hold a code block that `runnableShellCommand` accepts. */
export function hasShellCodeFence(markdown: string): boolean {
  return SHELL_FENCE.test(markdown);
}

/** The command a chat code block's Run in terminal sends, or null when it is not one shell line. */
export function runnableShellCommand(code: string, language: string): string | null {
  const body = code.endsWith("\n") ? code.slice(0, -1) : code;
  const command = body.trim();
  if (!SHELL_LANGUAGE.test(language) || command.length === 0 || command.endsWith("\\")) {
    return null;
  }
  // Control and invisible format characters (bidi overrides, zero-width) can
  // make the rendered command differ from what the terminal would receive.
  return /[\p{Cc}\p{Cf}]/u.test(body) ? null : command;
}
