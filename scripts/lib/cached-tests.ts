// @effect-diagnostics nodeBuiltinImport:off - Vite loads this before dependency installation and service initialization.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { GIT_OUTPUT_MAX_BYTES } from "../../.github/scripts/git-history.cjs";

// vp test supplies these defaults before Node loads Vitest, preserving even empty overrides.
const vitePlusTestDefaults = {
  JS_RUNTIME_NAME: process.release.name,
  JS_RUNTIME_VERSION: process.versions.node,
  NODE_PACKAGE_MANAGER: "vite-plus",
};

// On macOS file tracking replaces Bash and resolves PATH before applying a child's
// working directory. These suites rely on native shells, job control, or exec lookup.
const darwinNativeProcessTests = [
  "apps/server/src/cli/triage.test.ts",
  "apps/server/src/preview/PortScanner.test.ts",
  "apps/server/src/process/WorkerProcessSpawner.test.ts",
  "apps/server/src/project/ProjectSetupScriptRunner.test.ts",
  "scripts/release-desktop-workflow.test.ts",
];

export function missingVitePlusTestEnv() {
  return Object.entries(vitePlusTestDefaults).filter(([name]) => process.env[name] === undefined);
}

interface CachedTestTask {
  command: string;
  cwd?: string;
  dependsOn?: Array<string>;
  cache:
    | false
    | {
        env: Array<string>;
        input: Array<string | { auto: true } | { pattern: string; base: "workspace" }>;
        output: Array<string>;
        untrackedEnv?: Array<string>;
      };
}

/** Git, Vitest filters and cache keys use slash-separated paths on every host. */
export function relativeTestPath(base: string, target: string): string {
  return NodePath.relative(base, target).split(NodePath.sep).join("/");
}

/** Resolve Git and caller spellings to the same entry without merging distinct links. */
export function testPathResolver(root: string) {
  const resolved = new Map<string, string | undefined>([["", ""]]);
  const entries = new Map<string, Set<string>>();
  function resolve(file: string): string | undefined {
    if (resolved.has(file)) return resolved.get(file);
    const slash = file.lastIndexOf("/");
    const name = file.slice(slash + 1);
    if (name === ".." || NodePath.isAbsolute(file)) return undefined;
    const parent = resolve(slash < 0 ? "" : file.slice(0, slash));
    if (parent === undefined) return undefined;
    const directory = NodePath.join(root, parent);
    let names = entries.get(directory);
    if (!names) {
      try {
        names = new Set(NodeFS.readdirSync(directory));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        resolved.set(file, undefined);
        return undefined;
      }
      entries.set(directory, names);
    }
    let entry: string | undefined = name;
    if (!names.has(name)) {
      const target = NodePath.join(directory, name);
      const identity = NodeFS.lstatSync(target, { bigint: true, throwIfNoEntry: false });
      if (!identity) {
        entry = undefined;
      } else {
        const sameEntry = (alternate: string) => {
          const info = NodeFS.lstatSync(NodePath.join(directory, alternate), {
            bigint: true,
            throwIfNoEntry: false,
          });
          return info?.dev === identity.dev && info.ino === identity.ino;
        };
        const nativeName = NodePath.basename(NodeFS.realpathSync.native(target));
        if (names.has(nativeName) && sameEntry(nativeName)) {
          entry = nativeName;
        } else {
          // Some filesystems preserve the caller's spelling in realpath.
          const matches = [...names].filter(sameEntry);
          if (matches.length !== 1)
            throw new Error(`Cannot determine the directory entry for ${target}`);
          entry = matches[0];
        }
      }
    }
    const canonical = entry === undefined ? undefined : NodePath.posix.join(parent, entry);
    resolved.set(file, canonical);
    return canonical;
  }
  return resolve;
}

function quoteArgument(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

// Keep a large selection out of argv and the environment block, especially on Windows.
const requestFile = "T3_CHECK_CHANGED_TEST_REQUEST";
// check:changed passes a test its package's config leaves out, so a filter such as a file name or
// -t would pass a test it never ran, and shell syntax such as `||` would hide a failure.
const CHANGED_TEST_SCRIPT =
  /^vp test run(?: --passWithNoTests| --(?:config|dir|project) (?!-)[\w.@/:+=,-]+)*$/;
/** Whether check:changed can run a package's tests under this `test` script. */
export const isChangedTestScript = (command: string) => CHANGED_TEST_SCRIPT.test(command);
const changedTestEnv = "T3_CHECK_CHANGED_TEST_RUNTIME";
const testInstallEnv = "T3_CHECK_CHANGED_TEST_INSTALL";
const testWorkersEnv = "T3CODE_TEST_MAX_WORKERS";
const checkoutEnv = "T3_CHECK_CHANGED_TEST_CHECKOUT";
const searchPathEnv = "T3_CHECK_CHANGED_TEST_PATH";
const workspaceRoot = NodePath.resolve(import.meta.dirname, "../..");
// Tests run without the user's global Git config, as on CI. Git for Windows maps /dev/null too.
const testGitEnv = { GIT_CONFIG_GLOBAL: "/dev/null" };
const testEnv = [
  changedTestEnv,
  ...Object.keys(testGitEnv),
  testInstallEnv,
  checkoutEnv,
  searchPathEnv,
  // DEFAULT_UNTRACKED_ENV in vite-task a3c087a (Vite+ 1.4.0), less PWD and PATH: they name this
  // checkout, so the search path is tracked through searchPathEnv instead.
  "HOME",
  "USER",
  "TZ",
  "LANG",
  "SHELL",
  "XDG_RUNTIME_DIR",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "CI",
  "NODE_OPTIONS",
  "COREPACK_*",
  "NPM_CONFIG_STORE_DIR",
  "PNPM_HOME",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "LIBPATH",
  "DISPLAY",
  "TMP",
  "TEMP",
  // Not in that list, but os.tmpdir() reads it outside Windows.
  "TMPDIR",
  "VERCEL",
  "VERCEL_*",
  "NEXT_*",
  "USE_OUTPUT_FOR_EDGE_FUNCTIONS",
  "NOW_BUILDER",
  "VC_MICROFRONTENDS_CONFIG_FILE_NAME",
  "GITHUB_*",
  "RUNNER_*",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "WINDIR",
  "PATHEXT",
  "ProgramFiles",
  "ProgramFiles[(]x86[)]",
  "ELECTRON_RUN_AS_NODE",
  "JB_INTERPRETER",
  "_JETBRAINS_TEST_RUNNER_RUN_SCOPE_TYPE",
  "JB_IDE_*",
  "VSCODE_*",
  "DOCKER_*",
  "BUILDKIT_*",
  "COMPOSE_*",
  "PLAYWRIGHT_*",
  "VP_*",
  "*_TOKEN",
  "LC_*",
  "NODE_ENV",
  "VITE_*",
  "!VITE_CACHE_PATH",
  "VITEST*",
  "T3_TEST_*",
];

export function changedTestRuntime(
  platform: string,
  architecture: string,
  capabilities: Record<string, boolean>,
  git: string,
) {
  // Tests skip cases as root that another user runs, some name paths after the user, and some
  // check the modes of files they create, which the umask narrows.
  const user = process.getuid?.() ?? null;
  const umask = process.umask();
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([process.version, platform, architecture, user, umask, capabilities, git]),
    )
    .digest("hex");
}

const GIT_PROBE_TIMEOUT_MS = 30_000;
const sha256 = (data: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

/**
 * What git reads in a test beyond the repositories it makes: its version, the system config, and
 * the per-user ignore and attributes files it reads by default. Tests get no other GIT_* variable
 * and no XDG_CONFIG_HOME. Files and programs the system config names belong to the machine, as
 * git itself does.
 */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const gitEnv = {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("GIT_") && key !== "XDG_CONFIG_HOME"),
    ),
    ...testGitEnv,
  };
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, {
      cwd: NodeOS.tmpdir(),
      env: gitEnv,
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    });
    if (result.error) {
      if ("code" in result.error && result.error.code === "ENOENT") return undefined;
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    }
    // Raw bytes: decoding would read two paths that differ in a byte invalid in UTF-8 as one.
    return result.stdout;
  };
  const version = git(["version"]);
  if (version === undefined) return "no git";
  const config = git(["config", "-z", "--list", "--show-scope", "--show-origin"]) ?? "";
  const home = env.HOME || NodeOS.homedir();
  const defaults = ["ignore", "attributes"].map((name) => {
    const content = unlessAbsent(() =>
      NodeFS.readFileSync(NodePath.join(home, ".config/git", name)),
    );
    return content === undefined ? null : sha256(content);
  });
  return JSON.stringify({ version: version.toString().trim(), config: sha256(config), defaults });
}

const readInstallFile = (file: string) => unlessAbsent(() => NodeFS.readFileSync(file));

export function installFingerprint(root = workspaceRoot) {
  const modules = NodePath.join(root, "node_modules");
  const lock = readInstallFile(NodePath.join(modules, ".pnpm", "lock.yaml"));
  const manifest = readInstallFile(NodePath.join(modules, ".modules.yaml"));
  const hash = NodeCrypto.createHash("sha256")
    .update(lock ?? "")
    .update("\0");
  if (!manifest) return hash.digest("hex");

  let normalized: unknown;
  try {
    normalized = JSON.parse(manifest.toString());
  } catch {
    return hash.update(manifest).digest("hex");
  }
  if (typeof normalized === "object" && normalized !== null && "prunedAt" in normalized) {
    delete normalized.prunedAt;
  }
  return hash.update(JSON.stringify(normalized)).digest("hex");
}

// A backslash separates path parts only on Windows; elsewhere it can be part of a file name.
const climbsOut = (path: string) => path.split(NodePath.sep === "\\" ? /[\\/]/ : "/")[0] === "..";

// Search path entries inside the checkout, written relative to it, so two checkouts compare equal.
// Only normalized entries qualify: `..` after a symlink can leave the checkout. A relative entry
// resolves against a group's folder in the checkout, so one that climbs out of it is checkout-specific.
export function checkoutSearchPath(searchPath: string, root = workspaceRoot) {
  return JSON.stringify(
    searchPath.split(NodePath.delimiter).map((entry) => {
      const normalized = NodePath.normalize(entry) === entry;
      if (!NodePath.isAbsolute(entry)) {
        return entry === "" || (normalized && !climbsOut(entry)) ? entry : { root, entry };
      }
      const relative = NodePath.relative(root, entry);
      return normalized && !NodePath.isAbsolute(relative) && !climbsOut(relative)
        ? { checkout: relative }
        : entry;
    }),
  );
}

export function changedTestRequestEnv(
  file: string,
  runtime: string,
  workers: number,
  cache: string,
  checkout: string,
  install = installFingerprint(),
) {
  return {
    [requestFile]: file,
    [changedTestEnv]: runtime,
    [testInstallEnv]: install,
    T3_CACHED_TESTS: "",
    [testWorkersEnv]: String(workers),
    [checkoutEnv]: checkout,
    [searchPathEnv]: checkoutSearchPath(process.env.PATH ?? ""),
    VITE_CACHE_PATH: cache,
    ...testGitEnv,
  };
}

// Windows cannot start a process whose command line passes 32,767 characters, and vp passes
// its arguments on to the tool it starts, so a long list of paths runs in several steps.
export const ARGUMENT_CHARACTERS = 24_000;

// A leading U+FEFF is part of the first name, so neither decoder drops it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

function gitPath(name: Uint8Array) {
  try {
    return strictUtf8.decode(name);
  } catch {
    throw new Error(`A file name is not UTF-8, so rename it: ${lossyUtf8.decode(name)}`);
  }
}

/**
 * The paths of a `git -z` listing. A lossy decode would name a file that is not on disk, so a test
 * whose name is not UTF-8 would drop out of the run unseen.
 */
export function gitPaths(stdout: Uint8Array) {
  const paths: Array<string> = [];
  let start = 0;
  for (let end = stdout.indexOf(0); end !== -1; end = stdout.indexOf(0, start)) {
    paths.push(gitPath(stdout.subarray(start, end)));
    start = end + 1;
  }
  paths.push(gitPath(stdout.subarray(start)));
  return paths;
}

export function matchesTestPath(file: string, filters: ReadonlyArray<string | undefined>) {
  return (
    filters.length === 0 ||
    filters.some(
      (filter) =>
        filter !== undefined && (filter === "" || file === filter || file.startsWith(`${filter}/`)),
    )
  );
}

export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

// Vitest reads a backslash in a name it discovers as a path separator, so such a test never
// matches its group, and check:changed, which lets a group's config leave files out, would skip it.
function refuseBackslashNames(files: Array<string>) {
  const unrunnable = files.filter((file) => file.includes("\\"));
  if (unrunnable.length) {
    throw new Error(
      `Vitest cannot run a test whose path holds a backslash, so rename it: ${unrunnable.join(", ")}`,
    );
  }
}

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

/** What `read` finds at a path, or undefined when nothing is there, as under a file. */
export function unlessAbsent<A>(read: () => A): A | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && "code" in error && ABSENT.has(String(error.code)))
      return undefined;
    throw error;
  }
}

const ASCII = /^\p{ASCII}*$/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** Whether a regular file is at `path`, following symlinks. */
export const isFileAt = (path: string) =>
  unlessAbsent(() => NodeFS.statSync(path))?.isFile() === true;

/**
 * A name as a disk that ignores case and Unicode normalization compares it, folded one character
 * at a time as full case folding does: `ß`, `ẞ` and `ss` key alike, and so does a final sigma.
 * Default-ignorable code points, such as a zero-width joiner, which such disks may skip, drop out.
 */
export const nameKey = (name: string) =>
  ASCII.test(name)
    ? name.toLowerCase()
    : Array.from(name.normalize("NFC").replace(DEFAULT_IGNORABLE, ""), (character) =>
        character.toLowerCase().toUpperCase().toLowerCase(),
      )
        .join("")
        .normalize("NFC");

/** Vendored read-only references, as any spelling of `.repos` a disk takes for it: no workspace
 * builds or tests the files in them. */
export const isReferenceRepoPath = (file: string) => nameKey(file).startsWith(".repos/");

export function cachedTestTasks(
  raw: string | undefined,
  root = workspaceRoot,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Vite loads this before dependency installation; tests supply the platform directly.
  platform: NodeJS.Platform = process.platform,
): Record<string, CachedTestTask> {
  const file = process.env[requestFile];
  const changed = !raw && !!file;
  if (changed) raw = NodeFS.readFileSync(file, "utf8");
  if (!raw) return {};
  const request: unknown = JSON.parse(raw);
  if (
    typeof request !== "object" ||
    request === null ||
    !("files" in request) ||
    !Array.isArray(request.files) ||
    !("groupSize" in request) ||
    typeof request.groupSize !== "number" ||
    !Number.isSafeInteger(request.groupSize) ||
    request.groupSize < 1
  ) {
    throw new Error("Invalid cached test request");
  }
  const uncached = "uncached" in request ? request.uncached : [];
  if (!Array.isArray(uncached) || !uncached.every((file) => typeof file === "string")) {
    throw new Error("Invalid uncached test files");
  }
  const completed: unknown = changed && "completed" in request ? request.completed : [];
  if (!Array.isArray(completed) || !completed.every((task) => typeof task === "string")) {
    throw new Error("Invalid completed test tasks");
  }
  const skip = new Set(completed);
  const files: Array<string> = [];
  for (const file of request.files) {
    if (
      typeof file !== "string" ||
      NodePath.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..") ||
      !TEST_FILE.test(file)
    ) {
      throw new Error("Cached tests must be test files inside the checkout");
    }
    files.push(file);
  }
  refuseBackslashNames(files);
  // The group runner takes only the files Vitest reports, which it spells as the disk does, so each
  // test, and each uncached test, goes by that spelling. A deleted test keeps its own.
  const resolve = testPathResolver(root);
  const onDisk = (file: string) => resolve(file) ?? file;
  const hostUncached = platform === "darwin" ? darwinNativeProcessTests : [];
  const uncachedFiles = new Set([...hostUncached, ...uncached].map(onDisk));
  const tasks: Record<string, CachedTestTask> = {};
  const nodeCommand = [
    ...missingVitePlusTestEnv().map(([name, value]) => `${name}=${quoteArgument(value)}`),
    "node",
  ].join(" ");
  const sorted = [...new Set(files.map(onDisk))].sort();
  const testScripts = new Map<string, string | undefined>();
  const testScript = (directory: string) => {
    if (!testScripts.has(directory)) {
      const file = NodePath.join(directory, "package.json");
      const manifest: unknown = NodeFS.existsSync(file)
        ? JSON.parse(NodeFS.readFileSync(file, "utf8"))
        : undefined;
      testScripts.set(
        directory,
        typeof manifest === "object" &&
          manifest !== null &&
          "scripts" in manifest &&
          typeof manifest.scripts === "object" &&
          manifest.scripts !== null &&
          "test" in manifest.scripts &&
          typeof manifest.scripts.test === "string"
          ? manifest.scripts.test
          : undefined,
      );
    }
    return testScripts.get(directory);
  };
  const packages = new Map<string, Array<string>>();
  for (const file of sorted) {
    // A package without a test script runs its tests in the enclosing package's suite.
    let directory = NodePath.dirname(NodePath.join(root, file));
    while (directory !== root && testScript(directory) === undefined) {
      directory = NodePath.dirname(directory);
    }
    const entries = packages.get(directory) ?? [];
    entries.push(file);
    packages.set(directory, entries);
  }
  for (const [directory, entries] of packages) {
    const command = directory === root ? "vp test run" : testScript(directory)!;
    if (
      (changed && !isChangedTestScript(command)) ||
      (command !== "vp test run" && !command.startsWith("vp test run "))
    ) {
      throw new Error(`Unsupported test command in ${directory}: ${command}`);
    }
    const runner = relativeTestPath(
      directory,
      NodePath.join(root, "scripts/lib/run-cached-test-group.ts"),
    );
    // check:changed runs the tests beside a change as `vp test run --passWithNoTests` would, so a
    // test the package's config leaves out passes there, while test:cached refuses one.
    const program = `${nodeCommand} ${quoteArgument(runner)}${changed ? " --allow-excluded" : ""}`;
    const allowEmpty = changed && !command.split(/\s+/).includes("--passWithNoTests");
    // Each install has its own module cache, which separate Vitest runs would race to rebuild.
    const moduleCache = relativeTestPath(
      directory,
      NodePath.join(
        root,
        "node_modules/.vitest-cache/check-changed",
        process.env[testInstallEnv] ?? "",
      ),
    );
    const options = `${command.slice("vp test run".length)}${allowEmpty ? " --passWithNoTests" : ""}${changed ? ` --fsModuleCachePath ${quoteArgument(moduleCache)}` : ""}`;
    const argument = (file: string) =>
      quoteArgument("./" + relativeTestPath(directory, NodePath.join(root, file)));
    const cacheable = entries.filter((file) => !uncachedFiles.has(file));
    const groups: Array<Array<string>> = [];
    const groupSize = request.groupSize;
    let group: Array<string> = [];
    let length = 0;
    const close = () => {
      groups.push(group);
      group = [];
      length = 0;
    };
    for (const file of cacheable) {
      const characters = argument(file).length + 1;
      if (group.length > 0 && length + characters > ARGUMENT_CHARACTERS) close();
      group.push(file);
      length += characters;
      const hash = NodeCrypto.createHash("sha256").update(file).digest().readUInt32BE();
      if (hash % groupSize === 0 || group.length === 2 * groupSize) close();
    }
    if (group.length > 0) groups.push(group);
    groups.push(...entries.filter((file) => uncachedFiles.has(file)).map((file) => [file]));
    const server = changed && directory === NodePath.join(root, "apps", "server");
    let previousServerTask: string | undefined;
    for (const group of groups) {
      const key = NodeCrypto.createHash("sha256").update(group.join("\0")).digest("hex");
      const task = `test-cache:${key}`;
      if (skip.has(task)) continue;
      const dependsOn = previousServerTask ? [previousServerTask] : undefined;
      if (server) previousServerTask = task;
      const uncachedGroup = uncachedFiles.has(group[0]!);
      // Vite+ reports VITE_CACHE_PATH to Vite's loadEnv and keys the group by it, so it is set
      // empty here and removed again in each test by packages/shared/src/testing/providerEnv.ts.
      const prefix = changed ? `${uncachedGroup ? `${requestFile}= ` : ""}VITE_CACHE_PATH= ` : "";
      tasks[task] = {
        command: `${prefix}${program} ${group.map(argument).join(" ")} --${options}`,
        ...(directory === root ? {} : { cwd: relativeTestPath(root, directory) }),
        ...(dependsOn ? { dependsOn } : {}),
        cache: uncachedGroup
          ? false
          : {
              env: [...Object.keys(vitePlusTestDefaults), ...(changed ? testEnv : [])],
              // Vitest reads and rewrites these caches while running otherwise unchanged tests.
              input: [
                { auto: true },
                "!**/node_modules/.vite/**",
                "!**/node_modules/.vitest-cache/**",
                ...(changed
                  ? [
                      // A linked worktree stores an absolute gitdir pointer here.
                      "!.git",
                      "!.git/**",
                    ].map((pattern) => ({ pattern, base: "workspace" as const }))
                  : []),
              ],
              output: [],
              // The free slots set the worker count, which schedules the same tests. The root
              // test config reads it (scripts/lib/test-workers.ts).
              ...(changed ? { untrackedEnv: [testWorkersEnv] } : {}),
            },
      };
    }
  }
  return {
    ...tasks,
    "test-cache": {
      command: 'node -e ""',
      dependsOn: Object.keys(tasks),
      cache: false,
    },
  };
}
