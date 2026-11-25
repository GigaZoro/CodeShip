// @effect-diagnostics nodeBuiltinImport:off - This Bun launcher only loads the environment and starts Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const [recorder, ...args] = process.argv.slice(2);
if (recorder !== "codex" && recorder !== "claude") {
  throw new Error("Usage: run-replay-recorder.ts codex|claude [recorder arguments]");
}

// Bun loads the package's dotenv files and expands their values. Node hosts the recorder
// because its dependencies include Node built-ins that Bun does not provide on Windows.
const script =
  recorder === "codex"
    ? "record-codex-app-server-replay-fixture.ts"
    : "record-claude-agent-sdk-replay-fixture.ts";
const child = NodeChildProcess.spawnSync(
  "node",
  [NodeURL.fileURLToPath(new URL(script, import.meta.url)), ...args],
  {
    stdio: "inherit",
  },
);
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exitCode = child.status ?? 1;
