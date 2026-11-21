// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - A synchronous maintainer script over git.
// The weekly upstream sync's bounds; automations/upstream-sync.md says when to run each command.
// Run inside the sync worktree: begin | status | land | lockfile [<merge commit>] print one JSON line; check runs check:changed.
import * as NodeChildProcess from "node:child_process";
import { begin, checkCommand, land, lockfileCheck, status } from "./lib/upstream-sync.ts";

const command = process.argv[2];
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
      : command === "land"
        ? land(process.cwd(), now)
        : command === "lockfile"
          ? lockfileCheck(process.cwd(), process.argv[3])
          : undefined;
if (result === undefined) {
  console.error(
    "Usage: node scripts/upstream-sync.ts begin | status | land | lockfile [<merge commit>] | check",
  );
  process.exit(2);
}
console.log(JSON.stringify(result));
