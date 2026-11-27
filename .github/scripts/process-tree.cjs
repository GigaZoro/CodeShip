// Runs a command so that a stop ends it with every process it started, also what outlives it. On POSIX the command
// runs in a process group of its own, led by this file as an anchor that lives until the tree ends, so the group's id
// stays the tree's; should its caller die first, the anchor has the tree ended. On Windows, which has no process
// groups, the shared PowerShell walk ends the tree.
const { spawn, spawnSync } = require("node:child_process");
// How long ending a tree may take, counted from the stop's start.
const STOP_TREE_MS = 30 * 1000;
const GONE_POLL_MS = 50;

/** Signals every process of `group`; false when it has none left. */
function signalGroup(group, name) {
  try {
    process.kill(-group, name);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

/** True while `group` has a process, also one this process may not signal. */
function groupAlive(group) {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

/** Every process as `pid -> { ppid, pgid }`, listed within what is left until `deadline`. */
function listProcesses(deadline) {
  const listing = spawnSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="], {
    encoding: "utf8",
    timeout: Math.max(1, Math.ceil(deadline - performance.now())),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) throw new Error(`ps failed: ${listing.stderr.trim()}`);
  const table = new Map();
  for (const line of listing.stdout.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) table.set(pid, { ppid, pgid });
  }
  return table;
}

/** The groups of the processes below the members of `groups`, other than those and the caller's own. */
function groupsBelow(table, groups) {
  const children = Map.groupBy(table.keys(), (pid) => table.get(pid).ppid);
  const tree = [...table].filter(([, { pgid }]) => groups.has(pgid)).map(([pid]) => pid);
  const seen = new Set(tree);
  for (const pid of tree) {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      tree.push(child);
    }
  }
  const own = table.get(process.pid)?.pgid;
  const found = new Set(tree.map((pid) => table.get(pid).pgid));
  return [...found].filter((group) => group > 1 && group !== own && !groups.has(group));
}

/**
 * Ends process group `group` and every process below its members, in groups of their own too, and resolves once all
 * are gone. Each group is frozen before a listing: a frozen process can neither fork nor reap a child, so a group the
 * listing finds keeps its id until the kill. The kill comes last, after a failure too, all within STOP_TREE_MS.
 */
async function endGroup(group) {
  // kill(-1) signals every process the user owns, and kill(0) the caller's own group.
  if (!Number.isInteger(group) || group <= 1)
    throw new Error(`${group} is not a process group to end.`);
  const deadline = performance.now() + STOP_TREE_MS;
  const groups = [group];
  let failure = null;
  try {
    signalGroup(group, "SIGSTOP");
    for (;;) {
      const found = groupsBelow(listProcesses(deadline), new Set(groups));
      if (found.length === 0) break;
      if (performance.now() > deadline) {
        throw new Error(`the processes of ${group} went on starting groups past the stop's limit.`);
      }
      for (const each of found) {
        groups.push(each);
        signalGroup(each, "SIGSTOP");
      }
    }
  } catch (error) {
    failure = error;
  }
  // The deepest first, while the processes that started them stay frozen.
  for (const each of groups.toReversed()) {
    try {
      signalGroup(each, "SIGKILL");
    } catch (error) {
      failure ??= error;
    }
  }
  while (groups.some(groupAlive)) {
    if (performance.now() > deadline) {
      failure ??= new Error(
        `the processes of ${group} did not end within ${STOP_TREE_MS / 1000} seconds.`,
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS));
  }
  if (failure) throw failure;
}

/** Ends a Windows tree with the shared walk, which also finds what a root that exited left running. */
function stopWindowsTree(windows, root) {
  return new Promise((resolve, reject) => {
    const stopper = spawn("powershell.exe", windows.windowsStopTreeArgs(root), {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: STOP_TREE_MS,
      windowsHide: true,
    });
    const said = [];
    stopper.stderr.on("data", (chunk) => said.push(chunk));
    stopper.on("error", reject);
    stopper.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `could not stop the processes of ${root.pid}: ${Buffer.concat(said).toString().trim()}`,
          ),
        );
    });
  });
}

function spawnWindowsTree(command, args, options) {
  const windows = require("../../packages/shared/src/windowsProcessTreeScript.ts");
  const rootOf = windows.windowsTreeRootFromNow();
  const child = spawn(command, args, options);
  let root = child.pid === undefined ? null : rootOf(child.pid);
  child.once("exit", () => {
    if (root) root = windows.endedWindowsTreeRoot(root);
  });
  const { promise: done, resolve, reject } = Promise.withResolvers();
  let stopping = null;
  const stop = () => {
    if (root === null || stopping) return;
    stopping = stopWindowsTree(windows, root);
    stopping.catch(reject);
  };
  child.on("error", reject);
  child.on("close", (code, signal) => {
    const stopped = stopping !== null;
    (stopping ?? Promise.resolve()).then(() => resolve({ code, signal, stopped }), reject);
  });
  return { child, stop, done };
}

/**
 * Spawns `command` as `spawn` would. `stop()` ends it with every process it started; `done` settles once the command
 * and those processes are gone, to `{ code, signal, stopped }`, where `stopped` says a stop ended the command. A stop
 * that fails rejects `done` at once. On POSIX the tree also ends when the command exits.
 */
function spawnTree(command, args, { stdio, shell = false, ...options } = {}) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
  if (process.platform === "win32")
    return spawnWindowsTree(command, args, { stdio, shell, ...options });
  const fds =
    typeof stdio === "string" ? [stdio, stdio, stdio] : (stdio ?? ["pipe", "pipe", "pipe"]);
  const child = spawn(
    process.execPath,
    [__filename, "anchor", JSON.stringify({ command, args, shell })],
    {
      ...options,
      detached: true,
      stdio: [...fds.slice(0, 3), "ipc"],
    },
  );
  const { promise: done, resolve, reject } = Promise.withResolvers();
  let status = null;
  let failed = null;
  let stopRequested = false;
  let ending = null;
  const end = () => {
    if (ending === null && child.pid !== undefined) {
      ending = endGroup(child.pid);
      ending.catch(reject);
    }
    return ending ?? Promise.resolve();
  };
  child.on("message", (message) => {
    if (message.exit) status = message.exit;
    if (message.error) failed = new Error(message.error);
    void end();
  });
  child.on("exit", () => void end());
  child.on("error", reject);
  child.on("close", () => {
    end().then(() => {
      if (failed) reject(failed);
      else
        resolve({ ...(status ?? { code: null, signal: null }), stopped: stopRequested && !status });
    }, reject);
  });
  const stop = () => {
    stopRequested = true;
    void end();
  };
  return { child, stop, done };
}

/** A child nothing stops, in the shape spawnTree returns: `done` settles once its output closed. */
function spawnChild(command, args, options) {
  const child = spawn(command, args, options);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stopped: false }));
  });
  return { child, stop: () => {}, done };
}

/** The anchor: runs the command in its group, reports how it ended, and lives on until the tree ends. */
function anchor(spec) {
  const { command, args, shell } = JSON.parse(spec);
  process.on("disconnect", () => {
    // The caller died before it ended the tree. The group's id must stay the tree's until a stopper outside the
    // group ends it, since a process cannot freeze a group it is in.
    setInterval(() => {}, 60 * 1000);
    const stopper = spawn(process.execPath, [__filename, "stop", String(process.pid)], {
      detached: true,
      stdio: "ignore",
    });
    stopper.on("error", () => process.kill(-process.pid, "SIGKILL"));
    stopper.unref();
  });
  const child = spawn(command, args, { shell, stdio: "inherit" });
  const report = (message) => {
    if (process.connected) process.send(message);
  };
  child.on("error", (error) => report({ error: error.message }));
  child.on("exit", (code, signal) => report({ exit: { code, signal } }));
}

if (require.main === module) {
  const [mode, value, ...unread] = process.argv.slice(2);
  const valid = value !== undefined && unread.length === 0;
  if (valid && mode === "anchor") anchor(value);
  else if (valid && mode === "stop" && /^\d+$/.test(value)) {
    endGroup(Number(value)).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  } else {
    process.stderr.write("usage: process-tree.cjs anchor <spec> | stop <group>\n");
    process.exitCode = 2;
  }
}

module.exports = { STOP_TREE_MS, spawnChild, spawnTree };
