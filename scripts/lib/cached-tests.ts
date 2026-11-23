// @effect-diagnostics nodeBuiltinImport:off - Vite loads this before dependency installation and service initialization.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface CachedTestTask {
  command: string;
  cwd?: string;
  dependsOn?: Array<string>;
  cache:
    | false
    | {
        input: Array<string | { auto: true }>;
        output: Array<string>;
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
      names = new Set(NodeFS.readdirSync(directory));
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

export function matchesTestPath(file: string, filters: ReadonlyArray<string | undefined>) {
  return (
    filters.length === 0 ||
    filters.some(
      (filter) =>
        filter !== undefined && (filter === "" || file === filter || file.startsWith(`${filter}/`)),
    )
  );
}

export function cachedTestTasks(
  raw: string | undefined,
  root = NodePath.resolve(import.meta.dirname, "../.."),
): Record<string, CachedTestTask> {
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
  const files: Array<string> = [];
  for (const file of request.files) {
    if (
      typeof file !== "string" ||
      NodePath.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..") ||
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    ) {
      throw new Error("Cached tests must be test files inside the checkout");
    }
    files.push(file);
  }
  const tasks: Record<string, CachedTestTask> = {};
  const sorted = [...new Set(files)].sort();
  const packages = new Map<string, Array<string>>();
  for (const file of sorted) {
    let directory = NodePath.dirname(NodePath.join(root, file));
    while (directory !== root && !NodeFS.existsSync(NodePath.join(directory, "package.json"))) {
      directory = NodePath.dirname(directory);
    }
    const entries = packages.get(directory) ?? [];
    entries.push(file);
    packages.set(directory, entries);
  }
  for (const [directory, entries] of packages) {
    const manifest: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8"),
    );
    const command =
      directory !== root &&
      typeof manifest === "object" &&
      manifest !== null &&
      "scripts" in manifest &&
      typeof manifest.scripts === "object" &&
      manifest.scripts !== null &&
      "test" in manifest.scripts &&
      typeof manifest.scripts.test === "string"
        ? manifest.scripts.test
        : "vp test run";
    if (command !== "vp test run" && !command.startsWith("vp test run ")) {
      throw new Error(`Unsupported test command in ${directory}`);
    }
    const runner = relativeTestPath(
      directory,
      NodePath.join(root, "scripts/lib/run-cached-test-group.ts"),
    );
    const options = command.slice("vp test run".length);
    const cacheable = entries.filter((file) => !uncached.includes(file));
    const groups: Array<Array<string>> = [];
    for (let index = 0; index < cacheable.length; index += request.groupSize) {
      groups.push(cacheable.slice(index, index + request.groupSize));
    }
    groups.push(...entries.filter((file) => uncached.includes(file)).map((file) => [file]));
    for (const group of groups) {
      const key = NodeCrypto.createHash("sha256").update(group.join("\0")).digest("hex");
      const filters = group.map((file) => {
        const relative = relativeTestPath(directory, NodePath.join(root, file));
        return quoteArgument("./" + relative);
      });
      tasks[`test-cache:${key}`] = {
        command: `node ${quoteArgument(runner)}${options} ${filters.join(" ")}`,
        ...(directory === root ? {} : { cwd: relativeTestPath(root, directory) }),
        cache: uncached.includes(group[0]!)
          ? false
          : {
              // Vitest reads and rewrites these caches while running otherwise unchanged tests.
              input: [
                { auto: true },
                "!**/node_modules/.vite/**",
                "!**/node_modules/.vitest-cache/**",
              ],
              output: [],
            },
      };
    }
  }
  return {
    ...tasks,
    "test-cache": { command: 'node -e ""', dependsOn: Object.keys(tasks), cache: false },
  };
}
