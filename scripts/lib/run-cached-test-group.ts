// @effect-diagnostics nodeBuiltinImport:off - the standalone runner uses Vitest's Node API.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  createCLI,
  startVitest,
  type Reporter,
  type TestModule,
  type TestSpecification,
} from "vite-plus/test/node";
import { CHECKOUT_HEAD_ENV } from "./cached-tests.ts";
import { validateNestedVitestOptions } from "./cached-vitest-options.ts";

const checkout = NodePath.resolve(import.meta.dirname, "../..");
// GIT_DIR and its kin reach trace2 as def_param events, which name a repository Git may open
// without reporting it as a def_repo worktree.
const tracedEnv = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
];
// Matches both full (`HH:MM:SS.ffffff file:line | d0 | ...`) and brief (`d0 | ...`) trace2 perf lines.
const perfHeader =
  /^(?:\d{2}:\d{2}:\d{2}\.\d+\s+[^|]+\|\s*)?d\d+\s*\|\s*[^|]+\|\s*([a-z0-9_]+)\s*\|\s*[^|]*\|\s*[^|]*\|\s*[^|]*\|\s*[^|]*\| (.*)$/;
const multilinePerfEvents = new Set([
  "child_start",
  "data",
  "data_json",
  "def_param",
  "error",
  "printf",
  "region_enter",
  "region_leave",
]);
const cEscapes: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

function fromFileUrl(value: string, windows: boolean) {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    return NodeURL.fileURLToPath(value, { windows });
  } catch {
    return value.slice("file://".length);
  }
}

// Parses Git's sq_quote_buf_pretty / sq_append_quote_argv_pretty format used by trace2 perf
// `start` and `def_repo` lines. Returns undefined when a single-quoted token is unclosed.
function parsePerfWords(input: string): Array<string> | undefined {
  const words: Array<string> = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && input[i] === " ") i++;
    if (i >= input.length) break;
    let word = "";
    while (i < input.length && input[i] !== " ") {
      const ch = input[i]!;
      if (ch === "'") {
        i++;
        const start = i;
        while (i < input.length && input[i] !== "'") i++;
        if (i >= input.length) return undefined;
        word += input.slice(start, i);
        i++;
      } else if (ch === "\\" && (input[i + 1] === "'" || input[i + 1] === "!")) {
        word += input[i + 1]!;
        i += 2;
      } else {
        word += ch;
        i++;
      }
    }
    words.push(word);
  }
  return words;
}

// Parses GIT_ALTERNATE_OBJECT_DIRECTORIES entries separated by `delimiter`, handling Git's
// C-quoted entries (whose embedded delimiters do not split). Returns undefined on malformed quotes.
function splitAlternateObjectDirectories(
  input: string,
  delimiter: string,
): Array<string> | undefined {
  const entries: Array<string> = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      i++;
      const bytes: Array<number> = [];
      let closed = false;
      while (i < input.length) {
        const ch = input[i]!;
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        if (ch === "\\") {
          const next = input[i + 1];
          if (next === undefined) return undefined;
          const simple = cEscapes[next];
          if (simple !== undefined) {
            bytes.push(simple);
            i += 2;
            continue;
          }
          const octal = input.slice(i + 1, i + 4);
          if (/^[0-3][0-7]{2}$/.test(octal)) {
            bytes.push(Number.parseInt(octal, 8));
            i += 4;
            continue;
          }
          return undefined;
        }
        const start = i;
        while (i < input.length && input[i] !== '"' && input[i] !== "\\") i++;
        for (const byte of Buffer.from(input.slice(start, i), "utf8")) bytes.push(byte);
      }
      if (!closed) return undefined;
      entries.push(Buffer.from(bytes).toString("utf8"));
      if (i < input.length) {
        if (input[i] !== delimiter) return undefined;
        i++;
      }
    } else {
      const sep = input.indexOf(delimiter, i);
      const end = sep < 0 ? input.length : sep;
      entries.push(input.slice(i, end));
      i = sep < 0 ? input.length : sep + 1;
    }
  }
  return entries;
}

function removeTraces(traces: string) {
  try {
    NodeFS.rmSync(traces, { recursive: true, force: true });
  } catch {
    // On Windows a detached `git maintenance` process may still hold its trace file open.
  }
}

// Git writes one trace2 perf file per process without its cwd, so relative paths resolve against
// `def_repo` worktrees or, when none is logged, the group cwd up to the checkout root. `git ls-remote`
// and `git fetch` pass relative paths verbatim to `git-upload-pack`, while `git clone` may leave `..`
// segments after a temp cwd is deleted. Any unreadable or malformed trace record fails closed.
export function readsCheckoutGit(
  traces: string,
  checkoutPaths: ReadonlyArray<string>,
  options?: {
    cwd?: string | undefined;
    platform?: NodeJS.Platform | undefined;
  },
) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- this standalone Vitest runner has no Effect runtime.
  const platform = options?.platform ?? process.platform;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- this standalone Vitest runner has no Effect runtime.
  const nativePlatform = platform === process.platform;
  const win32 = platform === "win32";
  const pathMod = win32 ? NodePath.win32 : NodePath.posix;
  const caseless = platform === "win32" || platform === "darwin";
  const comparable = (path: string) => (caseless ? path.toLowerCase() : path);
  const resolved = (path: string) => {
    const normalized = pathMod.resolve(path);
    if (!nativePlatform) return [normalized];
    try {
      return [normalized, NodeFS.realpathSync.native(normalized)];
    } catch {
      return [normalized];
    }
  };
  const reaches = (path: string, targetList: ReadonlyArray<string>, inside: boolean) =>
    resolved(path).some((candidate) => {
      const key = comparable(candidate);
      return targetList.some((target) => {
        const prefix = target.endsWith(pathMod.sep) ? target : target + pathMod.sep;
        return key === target || (inside && key.startsWith(prefix));
      });
    });

  const checkoutRoot = checkoutPaths[0];
  const rootTargets = checkoutRoot ? resolved(checkoutRoot).map(comparable) : [];
  const gitTargetPaths = checkoutRoot
    ? [pathMod.join(checkoutRoot, ".git"), ...checkoutPaths.slice(1)]
    : [];
  const gitTargets = gitTargetPaths.flatMap((path) => resolved(path).map(comparable));
  const allTargets = [...rootTargets, ...gitTargets];

  const fallbackBases: Array<string> = [];
  const addFallbackBase = (dir: string) => {
    const normalized = pathMod.resolve(dir);
    if (!fallbackBases.includes(normalized)) fallbackBases.push(normalized);
  };
  const groupCwd = pathMod.resolve(options?.cwd ?? process.cwd());
  addFallbackBase(groupCwd);
  if (checkoutRoot) {
    let current = groupCwd;
    while (reaches(current, rootTargets, true) && !reaches(current, rootTargets, false)) {
      const parent = pathMod.dirname(current);
      if (parent === current) break;
      current = parent;
      addFallbackBase(current);
    }
    addFallbackBase(checkoutRoot);
  }

  for (const file of NodeFS.readdirSync(traces)) {
    const rawLines = NodeFS.readFileSync(NodePath.join(traces, file), "utf8").split(/\r?\n/);
    if (rawLines.at(-1) === "") rawLines.pop();
    const records: Array<{ event: string; payload: string }> = [];
    for (const line of rawLines) {
      const match = perfHeader.exec(line);
      if (match) {
        records.push({ event: match[1]!, payload: match[2]! });
        continue;
      }
      const previous = records.at(-1);
      if (!previous) return true;
      if (previous.event === "start" || previous.event === "def_repo") {
        if (parsePerfWords(previous.payload) !== undefined) return true;
        previous.payload += `\n${line}`;
      } else if (multilinePerfEvents.has(previous.event)) {
        previous.payload += `\n${line}`;
      } else {
        return true;
      }
    }
    if (!records.length) return true;

    const values: Array<string> = [];
    const bases: Array<string> = [];
    for (const record of records) {
      if (record.event === "start") {
        const argv = parsePerfWords(record.payload);
        if (!argv || !argv.length) return true;
        for (const arg of argv) {
          values.push(arg);
          const eq = arg.indexOf("=");
          if (eq >= 0) values.push(arg.slice(eq + 1));
        }
      } else if (record.event === "def_repo") {
        const payload = record.payload.replace(/^(?:\.\.)*/, "");
        if (!payload.startsWith("worktree:")) return true;
        const parsed = parsePerfWords(payload.slice("worktree:".length));
        if (!parsed || parsed.length !== 1) return true;
        const worktree = parsed[0]!;
        if (!pathMod.isAbsolute(worktree)) return true;
        if (reaches(worktree, allTargets, true)) return true;
        bases.push(worktree);
      } else if (record.event === "def_param") {
        const payload = record.payload.replace(/^(?:\.\.)*/, "");
        if (!payload) return true;
        const colon = payload.indexOf(":");
        if (colon === 0) return true;
        if (colon < 0) {
          if (tracedEnv.includes(payload) || /\s/.test(payload)) return true;
          continue;
        }
        const name = payload.slice(0, colon);
        const value = payload.slice(colon + 1);
        values.push(value);
        if (name === "GIT_ALTERNATE_OBJECT_DIRECTORIES") {
          const entries = splitAlternateObjectDirectories(value, pathMod.delimiter);
          if (!entries) return true;
          values.push(...entries);
        } else if (value.includes(pathMod.delimiter)) {
          values.push(...value.split(pathMod.delimiter));
        }
      }
    }
    for (const value of values) {
      const path = fromFileUrl(value, win32);
      if (!path) continue;
      if (pathMod.isAbsolute(path)) {
        if (reaches(path, allTargets, true)) return true;
        continue;
      }
      // Relative arguments such as `git add src/a.ts` in another repository stay its own.
      if (bases.some((base) => reaches(pathMod.resolve(base, path), allTargets, true))) return true;
      if (
        !bases.length &&
        fallbackBases.some((base) => {
          const candidate = pathMod.resolve(base, path);
          return reaches(candidate, rootTargets, false) || reaches(candidate, gitTargets, true);
        })
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Cached groups key on the files their tests read, not on HEAD, so a group whose Git reads this
 * checkout's repository keys on HEAD through Vite+'s runner client. When Git cannot show that it
 * traces this checkout, every group counts as a reader. The check runs after teardown, or at exit.
 */
function traceCheckoutGit() {
  // Outside `vp run` no cache records the group.
  const client = process.env.VP_RUN_NODE_CLIENT_PATH;
  if (!client) return undefined;
  const runner = NodeModule.createRequire(import.meta.url)(client).load();
  if (runner.getEnv(CHECKOUT_HEAD_ENV, { tracked: false }) === undefined) {
    throw new Error(`Vite+ did not pass ${CHECKOUT_HEAD_ENV} to the cached test group`);
  }
  const traces = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-trace-"));
  const traceEnv = {
    GIT_TRACE2_ENV_VARS: tracedEnv.join(","),
    GIT_TRACE2_PERF_BRIEF: "1",
  };
  let tests: string;
  let targets: Array<string>;
  let traced: boolean;
  try {
    const probe = NodePath.join(traces, "probe");
    tests = NodePath.join(traces, "tests");
    NodeFS.mkdirSync(probe);
    NodeFS.mkdirSync(tests);
    const located = NodeChildProcess.spawnSync(
      "git",
      ["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: checkout,
        encoding: "utf8",
        env: { ...process.env, ...traceEnv, GIT_TRACE2_PERF: probe },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const gitDirs = located.status === 0 ? located.stdout.split(/\r?\n/).filter(Boolean) : [];
    // The checkout's folder, its .git entry (file in a linked worktree), its git dir and its common git dir.
    targets = [checkout, NodePath.join(checkout, ".git"), ...gitDirs];
    traced = gitDirs.length === 2 && readsCheckoutGit(probe, targets);
  } catch (error) {
    removeTraces(traces);
    throw error;
  }
  // GIT_TRACE2_PERF is independent of GIT_TRACE2_EVENT, which GitVcsDriverCore sets for progress.
  Object.assign(process.env, traceEnv, { GIT_TRACE2_PERF: tests });
  let checked = false;
  const check = () => {
    if (checked) return;
    checked = true;
    process.off("exit", check);
    let reads = true;
    try {
      reads = !traced || readsCheckoutGit(tests, targets);
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(`Could not read the Git trace of the cached test group: ${error}\n`);
    }
    try {
      if (reads) runner.getEnv(CHECKOUT_HEAD_ENV);
    } finally {
      removeTraces(traces);
    }
  };
  process.on("exit", check);
  return check;
}

async function runCachedTestGroup(args: string[]) {
  // check:changed passes the files its package config leaves out, as `vp test run` would.
  const allowExcluded = args[0] === "--allow-excluded";
  const argv = allowExcluded ? args.slice(1) : args;
  const separator = argv.indexOf("--");
  const files = separator < 0 ? argv : argv.slice(0, separator);
  const packageArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const cli = createCLI();
  if (files.includes("--help")) {
    if (argv.length !== 1) throw new Error("--help must be used alone.");
    cli.parse([process.execPath, "vitest", "run", "--help"], { run: false });
    return;
  }
  const invalid = files.find((file) => file.startsWith("-"));
  if (invalid) throw new Error("Unknown option " + invalid);
  if (!files.length) throw new Error("A cached test group requires at least one test file");
  const requested = new Set(files.map((file) => NodePath.resolve(file)));
  validateNestedVitestOptions(packageArgs, cli);
  const { args: filters, options } = cli.parse(
    [process.execPath, "vitest", "run", ...packageArgs],
    {
      run: false,
    },
  );
  if (!cli.matchedCommand) throw new Error("The package test command must run tests");
  cli.matchedCommand.checkUnknownOptions();
  cli.matchedCommand.checkOptionValue();

  // The Vitest CLI treats --exclude as additional to the project's configured excludes.
  if (options.exclude) {
    options.cliExclude = [options.exclude].flat();
    delete options.exclude;
  }
  if (filters.some((filter) => filter.includes(":"))) options.includeTaskLocation ??= true;
  if (typeof options.typecheck?.only === "boolean") options.typecheck.enabled ??= true;
  // Only check:changed passes the commit; test:cached groups don't key on HEAD.
  const checkGitTrace = allowExcluded ? traceCheckoutGit() : undefined;

  const identity = (spec: TestSpecification) =>
    JSON.stringify([spec.project.name, spec.moduleId, spec.pool]);
  let scheduled: string[] = [];
  const active = new Map<string, string>();
  const finished = new Set<string>();
  let ambiguousModule: string | undefined;
  let completed = false;
  const member = (file: string) => requested.has(NodePath.resolve(file));
  function observeModule(module: TestModule) {
    const spec = module.toTestSpecification();
    const key = identity(spec);
    const previous = active.get(spec.taskId);
    // Vitest routes worker results by a hash. While two live specs share that hash,
    // even a terminal reporter event cannot identify which worker produced it.
    if (previous !== undefined && previous !== key) ambiguousModule ??= spec.moduleId;
    finished.delete(key);
    active.set(spec.taskId, key);
  }
  const observer: Reporter = {
    onInit(vitest) {
      // Vitest 5's start() uses this manager directly. Its glob resolves every
      // file:line filter before we narrow the specifications sent to the sequencer.
      const discovery: Pick<typeof vitest, "globTestSpecifications"> = vitest["specifications"];
      const discover = discovery.globTestSpecifications.bind(discovery);
      discovery.globTestSpecifications = async (filters) =>
        (await discover(filters)).filter((spec) => member(spec.moduleId));
    },
    onTestRunStart(specs) {
      scheduled = specs.map(identity);
      const found = new Set(specs.map((spec) => NodePath.resolve(spec.moduleId)));
      const missing = [...requested].filter((file) => !found.has(file));
      if (missing.length && !allowExcluded)
        throw new Error("Vitest did not discover: " + missing.join(", "));
      const extra = [...found].filter((file) => !requested.has(file));
      if (extra.length)
        throw new Error("Unexpected test files in cache group: " + extra.join(", "));
    },
    onTestModuleQueued: observeModule,
    onTestModuleCollected: observeModule,
    onTestModuleEnd(module) {
      const spec = module.toTestSpecification();
      const key = identity(spec);
      if (active.get(spec.taskId) !== key) return;
      active.delete(spec.taskId);
      if (["passed", "skipped"].includes(module.state())) finished.add(key);
      else finished.delete(key);
    },
    onTestRunEnd(_modules, errors, reason) {
      completed =
        reason === "passed" &&
        !errors.length &&
        active.size === 0 &&
        ambiguousModule === undefined &&
        (scheduled.length > 0 || allowExcluded) &&
        scheduled.every((key) => finished.has(key));
    },
  };
  const context = await startVitest(
    [...filters],
    { ...options, run: true, watch: false },
    {
      plugins: [
        {
          name: "codeship-cached-test-group",
          configureServer(server) {
            // The root server has resolved configured, default and CLI-selected reporters.
            const reporters = server.config.test?.reporters;
            if (!Array.isArray(reporters))
              throw new Error("Vitest has not initialized its reporters");
            if (!reporters.includes(observer)) reporters.push(observer);
          },
        },
      ],
    },
  );
  try {
    if (!process.exitCode && !completed) {
      if (ambiguousModule !== undefined) {
        throw new Error(
          "Overlapping Vitest tasks shared a result ID while running " + ambiguousModule,
        );
      }
      throw new Error("Vitest did not complete the requested test group: " + files.join(", "));
    }
  } finally {
    try {
      await context.exit();
    } finally {
      checkGitTrace?.();
    }
  }
}

if (import.meta.main) await runCachedTestGroup(process.argv.slice(2));
