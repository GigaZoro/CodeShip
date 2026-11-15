// @effect-diagnostics globalDate:off globalConsole:off - A synchronous maintainer script over git.
// The weekly upstream sync's bounds; automations/upstream-sync.md says when to run each command.
// Run inside the sync worktree: begin | status | land. Each prints one JSON line.
import { begin, land, status } from "./lib/upstream-sync.ts";

const command = process.argv[2];
const now = new Date();
const result =
  command === "begin"
    ? begin(process.cwd(), now)
    : command === "status"
      ? status(process.cwd(), now)
      : command === "land"
        ? land(process.cwd(), now)
        : undefined;
if (result === undefined) {
  console.error("Usage: node scripts/upstream-sync.ts begin | status | land");
  process.exit(2);
}
console.log(JSON.stringify(result));
