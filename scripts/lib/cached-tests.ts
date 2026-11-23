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

/** Use the spelling from discovery when both paths name the same directory entry. */
export function resolveTestPath(root: string, target: string, candidates: ReadonlyArray<string>) {
  const requested = relativeTestPath(root, target);
  if (!requested) return requested;
  const parts = requested.split("/");
  const folded = requested.toLowerCase();
  const alternatives = new Set<string>();
  for (const file of candidates) {
    if (file === requested || file.startsWith(requested + "/")) return requested;
    const normalized = file.toLowerCase();
    if (normalized === folded || normalized.startsWith(folded + "/")) {
      alternatives.add(file.split("/", parts.length).join("/"));
    }
  }
  if (alternatives.size === 0 || !NodeFS.existsSync(target)) return requested;
  for (const alternative of alternatives) {
    if (!NodeFS.existsSync(NodePath.join(root, alternative))) continue;
    let parent = root;
    const sameEntry = alternative.split("/").every((name, index) => {
      const entered = parts[index]!;
      if (entered !== name) {
        // Check each directory: case sensitivity can differ within one checkout, and
        // two distinct names can even be hard links to the same underlying file.
        const names = NodeFS.readdirSync(parent);
        if (names.includes(name) && names.includes(entered)) return false;
      }
      parent = NodePath.join(parent, name);
      return true;
    });
    if (sameEntry) return alternative;
  }
  return requested;
}

export function matchesTestPath(file: string, filters: Array<string>) {
  return (
    filters.length === 0 ||
    filters.some((filter) => filter === "" || file === filter || file.startsWith(`${filter}/`))
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
    if (!command.startsWith("vp test run")) {
      throw new Error(`Unsupported test command in ${directory}`);
    }
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
        const filter = relative.startsWith("-") ? "./" + relative : relative;
        return "'" + filter.replaceAll("'", "'\"'\"'") + "'";
      });
      tasks[`test-cache:${key}`] = {
        command: `${command} ${filters.join(" ")}`,
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
