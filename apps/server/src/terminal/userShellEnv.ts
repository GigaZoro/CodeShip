// The tmux/screen/Zellij keys name the multiplexer pane that launched the server,
// so inheriting them points multiplexer-aware tools at that unrelated pane.
const SERVER_ONLY_ENV_KEYS = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);

/** A server variable that a shell started for the user (a terminal, a command) must not inherit. */
export function isServerOnlyEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return (
    normalizedKey.startsWith("T3CODE_") ||
    normalizedKey.startsWith("VITE_") ||
    SERVER_ONLY_ENV_KEYS.has(normalizedKey)
  );
}
