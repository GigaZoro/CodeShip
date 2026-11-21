// @effect-diagnostics nodeBuiltinImport:off -- the model asks the kernel which numbers are in use.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";

type Kill = (pid: number, signal?: string | number) => boolean;

/**
 * `kill`, except that a signal to a process group whose number no process, group or session has
 * any longer is recorded instead of sent, as an unrelated group may have taken that number since.
 * A worker runs its source too, so it is given what it calls.
 */
function recordSignalsToFreedGroups(
  kill: Kill,
  execFileSync: typeof NodeChildProcess.execFileSync,
  record: (signal: string) => void,
): Kill {
  // macOS ps shows no session ids and Node reads none, so python3 asks getsid of every process.
  const sessionScript = [
    "import os, subprocess, sys",
    "try:",
    "    pids = [p for p in os.listdir('/proc') if p.isdigit()] if os.path.isdir('/proc/self') else \\",
    "        subprocess.run(['ps', '-A', '-o', 'pid='], capture_output=True, text=True, check=True).stdout.split()",
    "except Exception:",
    "    sys.exit(2)",
    "for pid in pids:",
    "    try:",
    "        if os.getsid(int(pid)) == int(sys.argv[1]): sys.exit(0)",
    "    except OSError:",
    "        pass",
    "sys.exit(1)",
  ].join("\n");
  const has = (id: number) => {
    try {
      kill(id, 0);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === "EPERM";
    }
  };
  const inUse = (id: number) => {
    if (has(id) || has(-id)) return true;
    try {
      execFileSync("python3", ["-c", sessionScript, String(id)], { stdio: "ignore" });
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false;
      throw error;
    }
  };
  return (pid, signal) => {
    if (pid < -1 && !inUse(-pid)) {
      record(`${pid} ${signal ?? "SIGTERM"}`);
      return true;
    }
    return kill(pid, signal);
  };
}

/**
 * Python, for a held command that leads its group, that defines `holders()`, the other processes of
 * the command's session, and `await_holder(watching)`, which calls `watching()` once it watches the
 * first of them and returns once that one ended, at once when none is left. It imports os, select,
 * subprocess and sys.
 */
export const AWAIT_HOLDER_PYTHON = [
  "import os, select, subprocess, sys",
  "def holders():",
  "    me = os.getpid()",
  "    pids = [int(p) for p in os.listdir('/proc') if p.isdigit()] if os.path.isdir('/proc/self') else \\",
  "        [int(p) for p in subprocess.run(['ps', '-A', '-o', 'pid='], capture_output=True, text=True, check=True).stdout.split()]",
  "    def session(pid):",
  "        try: return os.getsid(pid)",
  "        except OSError: return None",
  "    return [pid for pid in pids if pid != me and session(pid) == me]",
  "def await_holder(watching):",
  "    held = holders()",
  "    try:",
  "        if sys.platform == 'darwin':",
  "            ended = select.kqueue()",
  "            ended.control([select.kevent(held[0], select.KQ_FILTER_PROC, select.KQ_EV_ADD, select.KQ_NOTE_EXIT)], 0)",
  "        else:",
  "            ended = os.pidfd_open(held[0])",
  "    except (IndexError, ProcessLookupError):",
  "        watching()",
  "        return",
  "    watching()",
  "    if sys.platform == 'darwin': ended.control(None, 1)",
  "    else: select.select([ended], [], [])",
].join("\n");

const WORKER_RECORD = "T3_TEST_FREED_GROUP_SIGNALS";

/**
 * Source a worker runs first so that, while `watchFreedGroupSignals` is in scope, its signals to
 * freed groups are recorded. The worker must share this process's environment.
 */
export const freedGroupsWorkerPreamble = `{
  const watch = (${recordSignalsToFreedGroups.toString()});
  const kill = process.kill.bind(process);
  const watched = watch(kill, require("node:child_process").execFileSync, (signal) => {
    process.env.${WORKER_RECORD} += signal + "\\n";
  });
  process.kill = (pid, signal) =>
    process.env.${WORKER_RECORD} === undefined ? kill(pid, signal) : watched(pid, signal);
}
`;

/**
 * Within the scope, signals this process and its preambled workers send to freed groups are
 * recorded instead of sent; `signals` lists them.
 */
export const watchFreedGroupSignals = Effect.acquireRelease(
  Effect.sync(() => {
    const kill = process.kill;
    const signals: Array<string> = [];
    process.kill = recordSignalsToFreedGroups(
      kill.bind(process),
      NodeChildProcess.execFileSync,
      (signal) => signals.push(signal),
    ) as typeof process.kill;
    process.env[WORKER_RECORD] = "";
    return { kill, signals };
  }),
  ({ kill }) =>
    Effect.sync(() => {
      process.kill = kill;
      delete process.env[WORKER_RECORD];
    }),
).pipe(
  Effect.map(({ signals }) => ({
    signals: (): ReadonlyArray<string> => [
      ...signals,
      ...(process.env[WORKER_RECORD] ?? "").split("\n").filter((line) => line !== ""),
    ],
  })),
);
