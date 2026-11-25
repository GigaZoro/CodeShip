// `node bounded-git.cjs <timeoutMs> <git args…>` runs one git call and, past its limit, stops git and all it started.
// spawnSync's own timeout kills git alone: its transport (ssh, a credential helper) runs on, and once git is gone
// nothing leads to it. The processes stay in the caller's group, so Ctrl-C and a stopped command still reach them.
const { spawn, spawnSync } = require("node:child_process");

const TIMED_OUT_STATUS = 124;

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function stopTree(root) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a CommonJS script that loads no package
  if (process.platform === "win32") {
    // /T walks the tree from a leader that still runs, and this one does.
    // oxlint-disable-next-line t3code/no-raw-taskkill -- a CommonJS script that loads no package
    spawnSync("taskkill", ["/T", "/F", "/PID", String(root)], { windowsHide: true });
    return;
  }
  // Each process is stopped before its children are listed, so it cannot start one the walk misses.
  const found = new Set([root]);
  signal(root, "SIGSTOP");
  for (let grew = true; grew;) {
    grew = false;
    const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    for (const line of (listed.stdout ?? "").split("\n")) {
      const [pid, parent] = line.trim().split(/\s+/).map(Number);
      if (!found.has(parent) || found.has(pid)) continue;
      found.add(pid);
      signal(pid, "SIGSTOP");
      grew = true;
    }
  }
  for (const pid of found) signal(pid, "SIGKILL");
}

function main([timeoutMs, ...args]) {
  const child = spawn("git", args, { stdio: "inherit", windowsHide: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopTree(child.pid);
  }, Number(timeoutMs));
  child.on("error", (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (status) => {
    clearTimeout(timer);
    process.exitCode = timedOut ? TIMED_OUT_STATUS : (status ?? 1);
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { TIMED_OUT_STATUS };
