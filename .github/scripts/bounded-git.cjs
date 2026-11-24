// `node bounded-git.cjs <timeoutMs> <git args…>` runs one git call and, past its limit, stops git and all it started,
// for a caller that waits on git synchronously. spawnSync's own timeout kills git alone: its transport (ssh, a
// credential helper) runs on, and once git is gone nothing leads to it. process-tree.cjs ends the call's processes, also
// when this script dies first.
const { spawnTree } = require("./process-tree.cjs");

const TIMED_OUT_STATUS = 124;
const USAGE = "usage: bounded-git.cjs <timeoutMs> <git args…>";

async function main([timeoutMs, ...args]) {
  // A limit that is no positive number would stop git at once.
  if (!(Number(timeoutMs) > 0) || args.length === 0) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const { stop, done } = spawnTree("git", args, { stdio: "inherit", windowsHide: true });
  const timer = setTimeout(stop, Number(timeoutMs));
  try {
    const { code, stopped } = await done;
    process.exitCode = stopped ? TIMED_OUT_STATUS : (code ?? 1);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) void main(process.argv.slice(2));

module.exports = { TIMED_OUT_STATUS };
