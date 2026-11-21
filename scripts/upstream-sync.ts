// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - A synchronous maintainer script over git.
// The weekly upstream sync's bounds; automations/upstream-sync.md says when to run each command.
// Run inside the sync worktree: begin | status | land print one JSON line; check runs check:changed.
import * as NodeChildProcess from "node:child_process";
import { begin, checkCommand, land, status } from "./lib/upstream-sync.ts";

const [command = "", ...unread] = process.argv.slice(2);
// No command takes an argument: one it would not read, such as a mistyped flag, must not start a merge or a push.
if (!["begin", "status", "land", "check"].includes(command) || unread.length > 0) {
  console.error("Usage: node scripts/upstream-sync.ts begin | status | land | check");
  process.exit(2);
}
const now = new Date();
if (command === "check") {
  const { args, env } = checkCommand(process.cwd(), process.env);
  const checked = NodeChildProcess.spawnSync("vp", args, { stdio: "inherit", env });
  if (checked.error) throw checked.error;
  process.exit(checked.status ?? 1);
}
const result =
  command === "begin"
    ? begin(process.cwd(), now)
    : command === "status"
      ? status(process.cwd(), now)
      : land(process.cwd(), now);
console.log(JSON.stringify(result));
