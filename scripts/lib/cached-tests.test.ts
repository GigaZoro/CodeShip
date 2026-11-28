// @effect-diagnostics nodeBuiltinImport:off - verifies native task caching in isolated subprocesses.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { isLinuxHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";

import {
  ARGUMENT_CHARACTERS,
  cachedTestTasks,
  CHANGED_TEST_GROUP_SIZE,
  changedTestRequestEnv,
  changedTestRuntime,
  checkoutSearchPath,
  countServerTestGroups,
  gitEnvironment,
  gitPaths,
  installFingerprint,
  matchesTestPath,
  MAX_SERVER_CHAINS,
  relativeTestPath,
  serverTestChainCount,
} from "./cached-tests.ts";
import { readsCheckoutGit } from "./run-cached-test-group.ts";

// Vite+'s fspy skips tracking paths under /dev (such as Linux /dev/shm), so nested `vp run --cache`
// fixture workspaces must live outside /dev even when the outer test runner sets TMPDIR to /dev/shm.
const tracedTempDir = (): string => {
  const dir = NodeOS.tmpdir();
  if (!isLinuxHost) return dir;
  let resolved = dir;
  try {
    resolved = NodeFS.realpathSync(dir);
  } catch {
    // Keep dir as-is if realpath fails.
  }
  return resolved === "/dev" || resolved.startsWith("/dev/") ? "/tmp" : dir;
};

describe("cachedTestTasks", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "runs native process fixtures separately only when required on %s",
    (platform) => {
      const files = [
        "apps/server/src/cli/triage.test.ts",
        "apps/server/src/cli/update.test.ts",
        "apps/server/src/preview/PortScanner.test.ts",
        "apps/server/src/process/WorkerProcessSpawner.test.ts",
        "apps/server/src/project/ProjectSetupScriptRunner.test.ts",
        "scripts/release-desktop-workflow.test.ts",
      ];
      const tasks = cachedTestTasks(JSON.stringify({ files, groupSize: 16 }), undefined, platform);
      const runs = tasks["test-cache"]!.dependsOn!.map((key) => tasks[key]!);

      expect(runs.filter(({ cache }) => cache === false)).toHaveLength(
        platform === "darwin" ? 5 : 0,
      );
      for (const file of files) {
        const run = runs.find(({ command }) => command.includes(NodePath.basename(file)));
        expect(run, file).toBeDefined();
        expect(run?.cache === false).toBe(
          platform === "darwin" && !file.endsWith("update.test.ts"),
        );
      }
    },
  );

  it("matches Git and shard selections to the same package, file and cache exception", () => {
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const project = NodePath.join(root, "apps", "server");
    const file = NodePath.join(project, "src", "worker.test.ts");
    const gitFile = "apps/server/src/worker.test.ts";
    const shardFile = relativeTestPath(root, file);
    const filter = relativeTestPath(root, project);
    expect(shardFile).toBe(gitFile);
    expect(matchesTestPath(gitFile, [filter])).toBe(true);
    expect(matchesTestPath(shardFile, [filter])).toBe(true);
    const tasks = cachedTestTasks(
      JSON.stringify({
        files: [gitFile, shardFile],
        groupSize: 1,
        uncached: [relativeTestPath(root, file)],
      }),
      root,
    );
    const fileTasks = Object.entries(tasks).filter(([name]) => name !== "test-cache");
    expect(fileTasks).toHaveLength(1);
    expect(fileTasks[0]![1]).toMatchObject({
      cache: false,
      cwd: "apps/server",
      command: expect.stringContaining(
        "node '../../scripts/lib/run-cached-test-group.ts' './src/worker.test.ts' --",
      ),
    });
  });

  it("selects every test for a checkout-root path", () => {
    const root = NodePath.resolve(import.meta.dirname, "../..");
    for (const path of [".", root]) {
      expect(
        matchesTestPath("apps/server/src/auth/utils.test.ts", [
          NodePath.relative(root, NodePath.resolve(root, path)),
        ]),
      ).toBe(true);
    }
    expect(matchesTestPath("apps/server/src/auth/utils.test.ts", ["apps/server"])).toBe(true);
    expect(matchesTestPath("apps/server-other/a.test.ts", ["apps/server"])).toBe(false);
  });
  it("names a listed file whose name is not UTF-8 rather than leaving it out", () => {
    const bom = String.fromCodePoint(0xfeff);
    expect(gitPaths(Buffer.from(`${bom}a.test.ts\0研究.test.ts\0`))).toEqual([
      `${bom}a.test.ts`,
      "研究.test.ts",
      "",
    ]);
    const listing = Buffer.concat([Buffer.from("�.test.ts\0"), Buffer.from([0x61, 0xff])]);
    expect(() => gitPaths(listing)).toThrow(/not UTF-8, so rename it: a�$/);
  });
  it("keeps groups and their tasks stable when a test is inserted or removed", () => {
    const files = Array.from(
      { length: 80 },
      (_, index) => `src/${String(index * 2).padStart(3, "0")}.test.ts`,
    );
    for (const groupSize of [1, CHANGED_TEST_GROUP_SIZE, 8]) {
      const first = cachedTestTasks(JSON.stringify({ files, groupSize }));
      const largest = Math.max(
        ...Object.entries(first)
          .filter(([key]) => key !== "test-cache")
          .map(([, task]) => task.command.match(/'\.\/src\/[0-9]+\.test\.ts'/g)!.length),
      );
      expect(largest).toBeLessThanOrEqual(2 * groupSize);
      const second = cachedTestTasks(
        JSON.stringify({ files: [...files, "src/001.test.ts"], groupSize }),
      );
      const removed = Object.keys(first).filter((key) => !(key in second));
      const added = Object.keys(second).filter((key) => !(key in first));
      expect(removed.length).toBeLessThanOrEqual(groupSize === 1 ? 0 : 2);
      expect(added.length).toBeLessThanOrEqual(groupSize === 1 ? 1 : 3);
      for (const key of Object.keys(first).filter((key) => key !== "test-cache" && key in second))
        expect(second[key]).toEqual(first[key]);
    }
    // So check:changed's groups, bounded above, hold at most 8 files.
    expect(2 * CHANGED_TEST_GROUP_SIZE).toBeLessThanOrEqual(8);
  });

  it("keeps shell metacharacters in filenames out of the command", () => {
    const tasks = cachedTestTasks(
      JSON.stringify({ files: ["src/a'$(touch injected).test.ts"], groupSize: 1 }),
    );
    const task = Object.entries(tasks).find(([key]) => key !== "test-cache")![1];
    expect(task.command).toContain(
      "node 'scripts/lib/run-cached-test-group.ts' './src/a'\"'\"'$(touch injected).test.ts' --",
    );
  });

  it("rejects paths outside the checkout and empty groups", () => {
    for (const request of [
      { files: ["../elsewhere.test.ts"], groupSize: 1 },
      { files: ["/absolute.test.ts"], groupSize: 1 },
      { files: ["src/a.test.ts"], groupSize: 0 },
      { files: ["fixture\\..\\example.test.ts"], groupSize: 1 },
    ]) {
      expect(() => cachedTestTasks(JSON.stringify(request))).toThrow();
    }
    expect(() =>
      cachedTestTasks(JSON.stringify({ files: ["a\\b.test.ts"], groupSize: 1 })),
    ).toThrow("so rename it: a\\b.test.ts");
  });

  it("accepts spec files discovered by Vitest", () => {
    const tasks = cachedTestTasks(JSON.stringify({ files: ["src/example.spec.ts"], groupSize: 1 }));
    expect(
      Object.values(tasks).some((task) =>
        task.command.endsWith(
          "node 'scripts/lib/run-cached-test-group.ts' './src/example.spec.ts' --",
        ),
      ),
    ).toBe(true);
  });

  it("keeps each command's file list within the command line limit", () => {
    const directory = "d".repeat(240);
    const files = Array.from(
      { length: 40 },
      (_, index) => `src/${directory}/${directory}/${directory}/${directory}/${index}.test.ts`,
    );
    const tasks = Object.entries(cachedTestTasks(JSON.stringify({ files, groupSize: 1000 })));
    const commands = tasks.filter(([key]) => key !== "test-cache").map(([, task]) => task.command);
    expect(commands.length).toBeGreaterThan(1);
    const listed = commands.map((command) => command.match(/'\.\/[^']*'/g) ?? []);
    for (const arguments_ of listed) {
      expect(arguments_.join(" ").length).toBeLessThanOrEqual(ARGUMENT_CHARACTERS);
    }
    expect(listed.flat()).toHaveLength(files.length);
  });

  it("runs a package's files with the enclosing package's test script", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-owner-"));
    try {
      const module = NodePath.join(root, "apps/mobile/modules/x");
      await NodeFSP.mkdir(module, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(root, "apps/mobile/package.json"),
        JSON.stringify({ scripts: { test: "vp test run --project unit" } }),
      );
      await NodeFSP.writeFile(NodePath.join(module, "package.json"), "{}");
      const tasks = cachedTestTasks(
        JSON.stringify({ files: ["apps/mobile/modules/x/src/a.test.ts"], groupSize: 1 }),
        root,
      );
      expect(Object.values(tasks).find((task) => task.cwd)).toMatchObject({
        cwd: "apps/mobile",
        command: expect.stringContaining(
          "node '../../scripts/lib/run-cached-test-group.ts' './modules/x/src/a.test.ts' -- --project unit",
        ),
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "vp test run choice",
    "vp test run -t smoke",
    "vp test run --testNamePattern=smoke",
    "vp test run --project unit || true",
  ])(
    "refuses a package test script that can pass a test check:changed never ran: %s",
    async (test) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-script-"));
      try {
        await NodeFSP.mkdir(NodePath.join(root, "pkg"));
        await NodeFSP.writeFile(
          NodePath.join(root, "pkg/package.json"),
          JSON.stringify({ scripts: { test } }),
        );
        const files = ["pkg/a.test.ts"];
        expect(
          Object.keys(cachedTestTasks(JSON.stringify({ files, groupSize: 1 }), root)),
        ).toHaveLength(2);
        const request = NodePath.join(root, "request.json");
        await NodeFSP.writeFile(request, JSON.stringify({ files, groupSize: 1 }));
        vi.stubEnv("T3_CHECK_CHANGED_TEST_REQUEST", request);
        expect(() => cachedTestTasks(undefined, root)).toThrow(
          `Unsupported test command in ${NodePath.join(root, "pkg")}: ${test}`,
        );
      } finally {
        vi.unstubAllEnvs();
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("writes search path entries inside the checkout relative to it", () => {
    const [one, two] = ["one", "two"].map((name) => NodePath.join(NodeOS.tmpdir(), name)) as [
      string,
      string,
    ];
    const searchPath = (root: string, ...entries: Array<string>) =>
      checkoutSearchPath(entries.map((entry) => root + entry).join(NodePath.delimiter), root);
    const { sep } = NodePath;
    expect(searchPath(one, "", `${sep}bin`)).toBe(searchPath(two, "", `${sep}bin`));
    expect(searchPath(one, `${sep}x${sep}..${sep}bin`)).not.toBe(searchPath(one, `${sep}bin`));
    expect(searchPath(one, "")).not.toBe(checkoutSearchPath("<checkout>", one));
    expect(checkoutSearchPath("bin", one)).toBe(checkoutSearchPath("bin", two));
    expect(checkoutSearchPath(`..${sep}bin`, one)).not.toBe(checkoutSearchPath(`..${sep}bin`, two));
  });

  it("fingerprints the installed lockfile and manifest without the prune timestamp", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-install-"));
    const modules = NodePath.join(root, "node_modules");
    const manifest = NodePath.join(modules, ".modules.yaml");
    const lock = NodePath.join(modules, ".pnpm", "lock.yaml");
    try {
      await NodeFSP.mkdir(NodePath.dirname(lock), { recursive: true });
      await NodeFSP.writeFile(lock, "lockfileVersion: '9.0'");
      await NodeFSP.writeFile(manifest, JSON.stringify({ layoutVersion: 5, prunedAt: "first" }));
      const first = installFingerprint(root);
      await NodeFSP.writeFile(manifest, JSON.stringify({ layoutVersion: 5, prunedAt: "second" }));
      expect(installFingerprint(root)).toBe(first);

      await NodeFSP.writeFile(manifest, JSON.stringify({ layoutVersion: 6, prunedAt: "second" }));
      const changed = installFingerprint(root);
      expect(changed).not.toBe(first);
      await NodeFSP.writeFile(lock, "lockfileVersion: '10.0'");
      expect(installFingerprint(root)).not.toBe(changed);

      await NodeFSP.writeFile(manifest, "layoutVersion: 5");
      const yaml = installFingerprint(root);
      await NodeFSP.writeFile(manifest, "layoutVersion: 6");
      expect(installFingerprint(root)).not.toBe(yaml);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid === undefined)(
    "keys the test runtime on the user, its umask and its git",
    () => {
      using getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
      using umask = vi.spyOn(process, "umask").mockReturnValue(0o022);
      const keys = new Set([changedTestRuntime("linux", "x64", {}, "no git")]);
      getuid.mockReturnValue(1000);
      keys.add(changedTestRuntime("linux", "x64", {}, "no git"));
      umask.mockReturnValue(0o077);
      keys.add(changedTestRuntime("linux", "x64", {}, "no git"));
      keys.add(changedTestRuntime("linux", "x64", {}, "{}"));
      expect(keys.size).toBe(4);
    },
  );

  it("keys the Git files tests read, not the user's Git config they run without", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-git-"));
    try {
      const elsewhere = NodePath.join(home, "elsewhere");
      const env = {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: elsewhere,
        XDG_CONFIG_HOME: home,
      };
      const before = gitEnvironment(env);
      await NodeFSP.writeFile(
        NodePath.join(home, ".gitconfig"),
        "[core]\n\thooksPath = ~/hooks\n[commit]\n\tgpgSign = true\n",
      );
      await NodeFSP.writeFile(elsewhere, "[user]\n\tname = Other\n");
      await NodeFSP.mkdir(NodePath.join(home, "git"));
      await NodeFSP.writeFile(NodePath.join(home, "git", "config"), "[user]\n\tname = Other\n");
      await NodeFSP.writeFile(NodePath.join(home, "git", "ignore"), "*.log\n");
      expect(gitEnvironment(env)).toBe(before);
      // Git reads these by default even without a global config.
      const defaults = NodePath.join(home, ".config", "git");
      await NodeFSP.mkdir(defaults, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(defaults, "ignore"), "*.log\n");
      const ignored = gitEnvironment(env);
      expect(ignored).not.toBe(before);
      await NodeFSP.writeFile(NodePath.join(defaults, "attributes"), "* text=auto\n");
      expect(gitEnvironment(env)).not.toBe(ignored);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindowsHost)(
    "keys the whole system Git config by its bytes, not as UTF-8 reads them",
    async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-git-bytes-"));
      try {
        // A git whose system config, past spawnSync's 1 MiB default, ends in a byte that is not UTF-8.
        const key = async (byte: number) => {
          const bin = NodePath.join(root, String(byte));
          await NodeFSP.mkdir(bin);
          const config = NodePath.join(bin, "config");
          const value = `/${"x".repeat(2 * 1024 * 1024)}`;
          await NodeFSP.writeFile(
            config,
            Buffer.concat([
              Buffer.from(`system\0core.excludesfile\n${value}`),
              Buffer.from([byte, 0]),
            ]),
          );
          await NodeFSP.writeFile(
            NodePath.join(bin, "git"),
            `#!/bin/sh\n[ "$1" = version ] && echo "git version 2.43.0" || exec /bin/cat "\${0%/*}/config"\n`,
            { mode: 0o755 },
          );
          // Relative to the temp folder the probe runs Git in, so a `:` in its path cannot split PATH.
          const PATH = NodePath.relative(NodeOS.tmpdir(), bin);
          return gitEnvironment({ ...process.env, HOME: root, PATH });
        };
        expect(await key(0x80)).not.toBe(await key(0x81));
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("uses the requested workers, passes excluded files and chains only pending server tasks", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-request-"));
    try {
      const request = NodePath.join(directory, "request.json");
      const files = [
        "apps/server/a.test.ts",
        "apps/server/b.test.ts",
        "apps/server/c.test.ts",
        "apps/server/d.test.ts",
        "apps/web/a.test.ts",
        "apps/web/b.test.ts",
      ];
      const raw = { files, groupSize: 1 };
      const keys = cachedTestTasks(JSON.stringify(raw))["test-cache"]!.dependsOn!;
      const [first, completed, third, fourth, ...nonServer] = keys as [
        string,
        string,
        string,
        string,
        ...Array<string>,
      ];
      await NodeFSP.writeFile(request, JSON.stringify({ ...raw, completed: [completed] }));
      const env = changedTestRequestEnv(
        request,
        "runtime",
        3,
        NodePath.join(directory, "cache"),
        "state",
        "head",
      );
      vi.stubEnv("T3_CHECK_CHANGED_TEST_REQUEST", env.T3_CHECK_CHANGED_TEST_REQUEST);

      const tasks = cachedTestTasks(undefined);
      expect(env.T3CODE_TEST_MAX_WORKERS).toBe("3");
      expect(tasks["test-cache"]!.dependsOn).toEqual([first, third, fourth, ...nonServer]);
      expect(tasks[completed]).toBeUndefined();
      expect(tasks[first]!.dependsOn).toBeUndefined();
      expect(tasks[third]!.dependsOn).toEqual([first]);
      expect(tasks[fourth]!.dependsOn).toEqual([third]);
      for (const key of nonServer) expect(tasks[key]!.dependsOn).toBeUndefined();
      for (const key of tasks["test-cache"]!.dependsOn!) {
        const task = tasks[key]!;
        expect(task.command).not.toContain("--maxWorkers");
        // `vp test run --passWithNoTests` runs the files a package's config leaves out as passed.
        expect(task.command).toContain("run-cached-test-group.ts' --allow-excluded './");
        expect(task.command).toContain(" --passWithNoTests");
        expect(task.cache && task.cache.untrackedEnv).toEqual([
          "T3CODE_TEST_MAX_WORKERS",
          "TMP",
          "TEMP",
          "TMPDIR",
        ]);
        for (const name of ["T3CODE_TEST_MAX_WORKERS", "TMP", "TEMP", "TMPDIR"]) {
          expect(task.cache && task.cache.env).not.toContain(name);
        }
      }
      const ci = cachedTestTasks(JSON.stringify(raw));
      for (const key of keys) {
        expect(ci[key]!.dependsOn).toBeUndefined();
        expect(ci[key]!.command).not.toContain("--allow-excluded");
      }
    } finally {
      vi.unstubAllEnvs();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not add tasks without an explicit request", () => {
    expect(cachedTestTasks(undefined)).toEqual({});
  });

  it("caps server test chains between 1 and MAX_SERVER_CHAINS by slot budget", () => {
    expect(MAX_SERVER_CHAINS).toBe(4);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 12].map(serverTestChainCount)).toEqual([
      1, 1, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  it("splits apps/server groups across K independent serial chains without changing commands", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-chains-"));
    try {
      const request = NodePath.join(directory, "request.json");
      const files = Array.from({ length: 8 }, (_, index) => `apps/server/s${index}.test.ts`);
      const loadFor = async (serverChains: unknown, completed?: Array<string>) => {
        await NodeFSP.writeFile(
          request,
          JSON.stringify({
            files,
            groupSize: 1,
            ...(serverChains !== undefined ? { serverChains } : {}),
            ...(completed ? { completed } : {}),
          }),
        );
        vi.stubEnv("T3_CHECK_CHANGED_TEST_REQUEST", request);
        return cachedTestTasks(undefined);
      };

      const single = await loadFor(1);
      const keys = single["test-cache"]!.dependsOn!;
      expect(keys).toHaveLength(8);

      for (const chains of [1, 2, 3, 4]) {
        const tasks = await loadFor(chains);
        const taskKeys = tasks["test-cache"]!.dependsOn!;
        expect(taskKeys).toEqual(keys);

        // Commands and cache definitions stay identical across chain counts so Vite+ cache keys do not shift.
        for (const key of taskKeys) {
          expect(tasks[key]!.command).toBe(single[key]!.command);
          expect(tasks[key]!.cache).toEqual(single[key]!.cache);
        }

        // Partition into independent strictly serial chains: `chains` roots, every predecessor used at most once.
        const roots = taskKeys.filter((key) => tasks[key]!.dependsOn === undefined);
        expect(roots).toHaveLength(chains);
        const seenPredecessors = new Set<string>();
        for (const key of taskKeys) {
          const deps = tasks[key]!.dependsOn;
          if (!deps) continue;
          expect(deps).toHaveLength(1);
          expect(seenPredecessors.has(deps[0]!)).toBe(false);
          seenPredecessors.add(deps[0]!);
        }
        // Trace each root forward to confirm every task belongs to one serial chain of balanced length.
        const visited = new Set<string>();
        const lengths: Array<number> = [];
        for (const root of roots) {
          let current: string | undefined = root;
          let count = 0;
          while (current !== undefined) {
            expect(visited.has(current)).toBe(false);
            visited.add(current);
            count += 1;
            const next = taskKeys.filter((key) => tasks[key]!.dependsOn?.[0] === current);
            expect(next.length).toBeLessThanOrEqual(1);
            current = next[0];
          }
          lengths.push(count);
        }
        expect(visited.size).toBe(keys.length);
        expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
      }

      // Completed tasks are omitted before chaining so remaining tasks never depend on a skipped task.
      const resumed = await loadFor(2, [keys[0]!, keys[3]!]);
      const resumedKeys = resumed["test-cache"]!.dependsOn!;
      expect(resumedKeys).toHaveLength(6);
      for (const key of resumedKeys) {
        const dep = resumed[key]!.dependsOn?.[0];
        if (dep !== undefined) expect(resumedKeys).toContain(dep);
      }

      for (const invalid of [0, -1, 1.5, "2"]) {
        await expect(loadFor(invalid)).rejects.toThrow("Invalid server test chain count");
      }
    } finally {
      vi.unstubAllEnvs();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("balances uneven apps/server groups and uncached server files across chains and matches countServerTestGroups", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-test-balance-"));
    try {
      const request = NodePath.join(directory, "request.json");
      const serverFiles = Array.from({ length: 24 }, (_, index) => `apps/server/b${index}.test.ts`);
      const uncachedFile = serverFiles[5]!;
      const files = [...serverFiles, "apps/web/w1.test.ts", "apps/web/w2.test.ts"];
      const groupSize = 4;

      const expectedCount = countServerTestGroups(
        { files, groupSize, uncached: [uncachedFile] },
        undefined,
        "linux",
      );
      expect(expectedCount).toBeGreaterThanOrEqual(4);
      const repoRootWithTrailingSlash =
        NodePath.resolve(import.meta.dirname, "../..") + NodePath.sep;
      expect(
        countServerTestGroups(
          { files, groupSize, uncached: [uncachedFile] },
          repoRootWithTrailingSlash,
          "linux",
        ),
      ).toBe(expectedCount);
      expect(
        countServerTestGroups(
          { files: ["apps/web/w1.test.ts"], groupSize, uncached: [] },
          repoRootWithTrailingSlash,
          "linux",
        ),
      ).toBe(0);
      expect(
        countServerTestGroups({ files: [], groupSize, uncached: [] }, undefined, "linux"),
      ).toBe(0);

      await NodeFSP.writeFile(
        request,
        JSON.stringify({
          files,
          groupSize,
          uncached: [uncachedFile],
          serverChains: 3,
        }),
      );
      vi.stubEnv("T3_CHECK_CHANGED_TEST_REQUEST", request);
      const tasks = cachedTestTasks(undefined, undefined, "linux");
      const allKeys = tasks["test-cache"]!.dependsOn!;
      const serverKeys = allKeys.filter((key) => tasks[key]!.cwd === "apps/server");
      const webKeys = allKeys.filter((key) => tasks[key]!.cwd === "apps/web");

      expect(serverKeys.length).toBe(
        countServerTestGroups({ files, groupSize, uncached: [uncachedFile] }, undefined, "linux"),
      );
      expect(webKeys.length).toBeGreaterThanOrEqual(1);
      for (const key of webKeys) expect(tasks[key]!.dependsOn).toBeUndefined();

      // Verify groups actually have uneven file counts and include the uncached singleton group.
      const filesInTask = (key: string) =>
        (tasks[key]!.command.match(/'\.\/[^']+\.test\.ts'/g) ?? []).length;
      const groupSizes = serverKeys.map(filesInTask);
      expect(new Set(groupSizes).size).toBeGreaterThan(1);
      const uncachedKey = serverKeys.find((key) => tasks[key]!.cache === false);
      expect(uncachedKey).toBeDefined();
      expect(filesInTask(uncachedKey!)).toBe(1);
      expect(tasks[uncachedKey!]!.command).toContain("./b5.test.ts");

      // Trace the 3 serial chains and verify load balancing by file count.
      const roots = serverKeys.filter((key) => tasks[key]!.dependsOn === undefined);
      expect(roots).toHaveLength(3);
      const chainFileTotals: Array<number> = [];
      const visited = new Set<string>();
      for (const root of roots) {
        let current: string | undefined = root;
        let totalFiles = 0;
        while (current !== undefined) {
          expect(visited.has(current)).toBe(false);
          visited.add(current);
          totalFiles += filesInTask(current);
          const next = serverKeys.filter((key) => tasks[key]!.dependsOn?.[0] === current);
          expect(next.length).toBeLessThanOrEqual(1);
          current = next[0];
        }
        chainFileTotals.push(totalFiles);
      }
      expect(visited.size).toBe(serverKeys.length);
      expect(chainFileTotals.reduce((a, b) => a + b, 0)).toBe(serverFiles.length);

      // Trailing-slash root must omit cwd for root-level tests (never emit cwd: "").
      await NodeFSP.writeFile(
        request,
        JSON.stringify({
          files: ["root.test.ts", "apps/server/b0.test.ts"],
          groupSize,
        }),
      );
      const trailingRootTasks = cachedTestTasks(undefined, repoRootWithTrailingSlash, "linux");
      const trailingKeys = trailingRootTasks["test-cache"]!.dependsOn!;
      const rootTask = trailingKeys
        .map((key) => trailingRootTasks[key]!)
        .find((task) => task.command.includes("./root.test.ts"));
      expect(rootTask).toBeDefined();
      expect("cwd" in rootTask!).toBe(false);
      const serverTask = trailingKeys
        .map((key) => trailingRootTasks[key]!)
        .find((task) => task.command.includes("./b0.test.ts"));
      expect(serverTask?.cwd).toBe("apps/server");
      expect(Math.max(...chainFileTotals) - Math.min(...chainFileTotals)).toBeLessThanOrEqual(
        Math.max(...groupSizes),
      );
    } finally {
      vi.unstubAllEnvs();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  // Each `vp run` boots Vitest per task, so every behaviour is its own test with its own time budget.
  const withFixture = async (
    body: (fixture: {
      directory: string;
      runtimeEnv: NodeJS.ProcessEnv;
      write: (file: string, content: string) => Promise<void>;
      run: (files?: Array<string>, uncached?: Array<string>) => Promise<number | null>;
      cli: (...args: Array<string>) => Promise<NodeChildProcess.SpawnSyncReturns<string>>;
      packageTest: (
        cwd: string,
        ...args: Array<string>
      ) => NodeChildProcess.SpawnSyncReturns<string>;
      runGroup: (cwd: string, ...args: Array<string>) => NodeChildProcess.SpawnSyncReturns<string>;
      hits: () => Promise<number>;
      git: (...args: Array<string>) => string;
    }) => Promise<void>,
  ) => {
    const directory = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(tracedTempDir(), "cached-tests-")),
    );
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const write = (file: string, content: string) =>
      NodeFSP.writeFile(NodePath.join(directory, file), content);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    );
    const runtimeEnv: NodeJS.ProcessEnv = {
      JS_RUNTIME_NAME: undefined,
      JS_RUNTIME_VERSION: undefined,
      NODE_PACKAGE_MANAGER: undefined,
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        env,
      });
    const subprocess = (cwd: string, args: Array<string>) =>
      NodeChildProcess.spawnSync(process.execPath, args, {
        cwd,
        encoding: "utf8",
        env: {
          ...env,
          ...runtimeEnv,
          // Each command must initialize Vitest's environment before loading the package config.
          TEST: undefined,
          VITEST: undefined,
          NODE_ENV: undefined,
          NODE_OPTIONS: "",
          VP_REMOTE_CACHE: "off",
          VITE_CACHE_PATH: NodePath.join(directory, "cache"),
          PATH: `${NodePath.join(root, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH}`,
        },
        timeout: 30_000,
      });
    const packageTest = (cwd: string, ...args: Array<string>) =>
      subprocess(NodePath.join(directory, cwd), [
        NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin")),
        "test",
        "run",
        ...args,
      ]);
    const runGroup = (cwd: string, ...args: Array<string>) =>
      subprocess(NodePath.join(directory, cwd), [
        NodePath.join(directory, "scripts/lib/run-cached-test-group.ts"),
        ...args,
      ]);
    const cli = async (...args: Array<string>) => {
      const scripts = NodePath.join(directory, "scripts");
      for (const name of ["test-cached.ts", "check-changed-command.ts"]) {
        await NodeFSP.copyFile(NodePath.join(root, "scripts", name), NodePath.join(scripts, name));
      }
      await write(".gitignore", "node_modules/\ncache/\nscripts/\n.github/\n");
      return subprocess(directory, [NodePath.join(scripts, "test-cached.ts"), ...args]);
    };
    const run = (files = ["a.test.ts", "b.test.ts"], uncached: Array<string> = []) =>
      new Promise<number | null>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [NodePath.join(root, "node_modules/vite-plus/dist/bin.js"), "run", "test-cache"],
          {
            cwd: directory,
            env: {
              ...process.env,
              NODE_OPTIONS: "",
              VP_REMOTE_CACHE: "off",
              T3_CACHED_TESTS: JSON.stringify({ files, groupSize: 1, uncached }),
              VITE_CACHE_PATH: NodePath.join(directory, "cache"),
              PATH: `${NodePath.join(root, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH}`,
            },
            stdio: "ignore",
          },
        );
        child.once("error", reject);
        child.once("close", resolve);
      });
    const hits = async () => {
      const value: { tasks: Array<{ result: Record<string, unknown> }> } = JSON.parse(
        await NodeFSP.readFile(NodePath.join(directory, "cache/v18/last-summary.json"), "utf8"),
      );
      return value.tasks.filter((task) => "CacheHit" in task.result).length;
    };
    try {
      await NodeFSP.mkdir(NodePath.join(directory, "node_modules"));
      const lib = NodePath.join(directory, "scripts", "lib");
      await NodeFSP.mkdir(lib, { recursive: true });
      for (const file of [
        "run-cached-test-group.ts",
        "cached-vitest-options.ts",
        "cached-tests.ts",
        "sharded-tests.ts",
        "command-line.ts",
      ]) {
        await NodeFSP.copyFile(NodePath.join(import.meta.dirname, file), NodePath.join(lib, file));
      }
      const github = NodePath.join(directory, ".github", "scripts");
      await NodeFSP.mkdir(github, { recursive: true });
      await NodeFSP.copyFile(
        NodePath.join(root, ".github/scripts/git-history.cjs"),
        NodePath.join(github, "git-history.cjs"),
      );
      await NodeFSP.symlink(
        await NodeFSP.realpath(NodePath.join(root, "node_modules/vite-plus")),
        NodePath.join(directory, "node_modules/vite-plus"),
        "junction",
      );
      await write("package.json", '{"type":"module"}');
      await write(
        "vite.config.ts",
        `import {cachedTestTasks} from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(root, "scripts/lib/cached-tests.ts")).href)}; export default {run:{tasks:cachedTestTasks(process.env.T3_CACHED_TESTS, import.meta.dirname)},test:{include:["*.test.ts","*/*.test.ts"]}};`,
      );
      await write(
        "a.test.ts",
        'import {test,expect} from "vite-plus/test"; import {readFileSync} from "node:fs"; test("fixture",()=>expect(readFileSync("fixture.txt","utf8")).toMatch(/^hello/));',
      );
      await write(
        "b.test.ts",
        'import {test,expect} from "vite-plus/test"; test("independent",()=>expect(1).toBe(1));',
      );
      await write("fixture.txt", "hello");
      git("init", "--quiet");
      await body({ directory, runtimeEnv, write, run, cli, packageTest, runGroup, hits, git });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };

  it("dispatches a dash-prefixed test path as the only Vitest filter", () =>
    withFixture(async ({ write, cli }) => {
      await write("other--literal-path.test.ts", 'throw new Error("Unselected sibling was run");');
      await write(
        "--literal-path.test.ts",
        'import {test} from "vite-plus/test"; test("selected", () => {});',
      );
      const result = await cli("--", "--", "--literal-path.test.ts");
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }));

  it("selects a path and applies its cache exception using the filesystem's case rules", () =>
    withFixture(async ({ directory, write, cli }) => {
      await write(
        "Choice.test.ts",
        'import {test} from "vite-plus/test"; test("first spelling", () => {});',
      );
      const alternate = "CHOICE.TEST.TS";
      const caseInsensitive = await NodeFSP.access(NodePath.join(directory, alternate)).then(
        () => true,
        () => false,
      );
      if (!caseInsensitive) {
        await write(
          "choice.test.ts",
          'throw new Error("Distinct case-sensitive sibling was run");',
        );
      }
      const selected = caseInsensitive ? alternate : "Choice.test.ts";
      const result = await cli("--uncached", selected, selected);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const summary = await NodeFSP.readFile(
        NodePath.join(directory, "cache/v18/last-summary.json"),
        "utf8",
      );
      const tasks = JSON.parse(summary).tasks as Array<{
        task_name: string;
        result: Record<string, unknown>;
      }>;
      const fileTasks = tasks.filter((task) => task.task_name.includes("test-cache:"));
      expect(fileTasks).toHaveLength(1);
      expect(fileTasks[0]!.result).toMatchObject({ Spawned: { cache_status: "Disabled" } });
    }));

  it("selects an unrelated test after a tracked directory is replaced with a file", () =>
    withFixture(async ({ directory, write, cli, git }) => {
      const replaced = NodePath.join(directory, "replaced");
      await NodeFSP.mkdir(replaced);
      await write("replaced/stale.test.ts", "");
      git("add", "--", "replaced/stale.test.ts");
      await NodeFSP.rm(replaced, { recursive: true });
      await write("replaced", "regular file");

      const report = NodePath.join(directory, "selected.json");
      const result = await cli("--report", report, "b.test.ts");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(await NodeFSP.readFile(report, "utf8")).files).toEqual(["b.test.ts"]);
    }));

  it("selects tracked and new tests across a case-only directory rename", () =>
    withFixture(async ({ directory, write, cli, git }) => {
      const tracked = "Tracked.test.ts";
      const added = "New.test.ts";
      const passing = 'import {test} from "vite-plus/test"; test("selected", () => {});';
      await NodeFSP.mkdir(NodePath.join(directory, "Alias"));
      await write("Alias/" + tracked, passing);
      git("add", "--", "Alias/" + tracked);
      const insensitive = await NodeFSP.access(NodePath.join(directory, "alias")).then(
        () => true,
        () => false,
      );
      if (insensitive) {
        await NodeFSP.rename(
          NodePath.join(directory, "Alias"),
          NodePath.join(directory, "between"),
        );
        await NodeFSP.rename(
          NodePath.join(directory, "between"),
          NodePath.join(directory, "alias"),
        );
      } else {
        await NodeFSP.mkdir(NodePath.join(directory, "alias"));
      }
      await write("alias/" + added, passing);
      await NodeFSP.mkdir(NodePath.join(directory, "Aliases"));
      await write("Aliases/Extra.test.ts", 'throw new Error("Adjacent directory was run");');
      for (const spelling of ["Alias", "alias"]) {
        const report = NodePath.join(directory, "selected.json");
        const result = await cli("--report", report, spelling);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const files: string[] = JSON.parse(await NodeFSP.readFile(report, "utf8")).files;
        const expected = insensitive
          ? ["alias/" + added, "alias/" + tracked]
          : [spelling === "Alias" ? "Alias/" + tracked : "alias/" + added];
        expect(files.sort()).toEqual(expected.sort());
      }
    }));

  it("runs an exact group through the package's configured Vitest project", () =>
    withFixture(async ({ directory, write, cli, packageTest }) => {
      await NodeFSP.mkdir(NodePath.join(directory, "pkg"));
      await write(
        "pkg/package.json",
        JSON.stringify({
          type: "module",
          scripts: {
            test: "vp test run --config ./group.vite.ts --project selected --reporter=verbose",
          },
        }),
      );
      await write(
        "pkg/group.vite.ts",
        `export default {test:{projects:[
        "./vitest.selected.config.ts",
        {test:{name:"other",include:["*.test.ts"],env:{GROUP_PROJECT:"other"}}}
      ]}};`,
      );
      await write(
        "pkg/vitest.selected.config.ts",
        'export default {test:{name:"selected",include:["*.test.ts"],env:{GROUP_PROJECT:"selected"}}};',
      );
      const test =
        'import {test,expect} from "vite-plus/test"; import {writeFileSync} from "node:fs"; test("project",()=>{expect(process.env.GROUP_PROJECT).toBe("selected"); writeFileSync(import.meta.filename+".ran","selected");});';
      await write("pkg/First.test.ts", test);
      await write("pkg/Second.test.ts", test);
      await write("pkg/OtherFirst.test.ts", 'throw new Error("Unselected sibling was run");');
      const ordinary = packageTest(
        "pkg",
        "--config",
        "./group.vite.ts",
        "--project",
        "selected",
        "./Second.test.ts",
      );
      expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0);
      const marker = NodePath.join(directory, "pkg", "Second.test.ts.ran");
      expect(await NodeFSP.readFile(marker, "utf8")).toBe("selected");
      await NodeFSP.unlink(marker);
      const result = await cli("--group-size", "2", "pkg/First.test.ts", "pkg/Second.test.ts");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      for (const name of ["First", "Second"]) {
        expect(
          await NodeFSP.readFile(NodePath.join(directory, "pkg", name + ".test.ts.ran"), "utf8"),
        ).toBe("selected");
      }
    }));

  it("loads the package config with TEST set and never caches the selected test's failure", () =>
    withTestPackage("vp test run --passWithNoTests", async ({ write, cli, packageTest, hits }) => {
      await write(
        "pkg/vite.config.ts",
        'export default { test: { include: process.env.TEST === "true" ? ["*.test.ts"] : [] } };',
      );
      await write(
        "pkg/Selected.test.ts",
        'import { test } from "vite-plus/test"; test("selected", () => { throw new Error("selected test ran and failed"); });',
      );

      const ordinary = packageTest("pkg", "--passWithNoTests", "./Selected.test.ts");
      expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(1);
      expect(ordinary.stdout + ordinary.stderr).toContain("selected test ran and failed");

      const first = await cli("pkg/Selected.test.ts");
      const repeated = await cli("pkg/Selected.test.ts");
      expect(await hits()).toBe(0);
      for (const result of [first, repeated]) {
        expect(result.status, result.stdout + result.stderr).toBe(ordinary.status);
        expect(result.stdout + result.stderr).toContain("selected test ran and failed");
      }
    }));

  it("rejects a cache group member the package config excludes, which check:changed passes", () =>
    withTestPackage("vp test run --passWithNoTests", async (fixture) => {
      const { directory, write, cli, packageTest, runGroup } = fixture;
      await write(
        "pkg/vite.config.ts",
        'export default { test: { include: ["Included.test.ts"] } };',
      );
      await write(
        "pkg/Included.test.ts",
        'import { test } from "vite-plus/test"; test("included", () => {});',
      );
      await write("pkg/Excluded.test.ts", 'throw new Error("unexpected excluded test execution");');

      const ordinary = packageTest(
        "pkg",
        "--passWithNoTests",
        "--reporter=json",
        "--outputFile=ordinary.json",
        "./Included.test.ts",
        "./Excluded.test.ts",
      );
      expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0);
      const report = JSON.parse(
        await NodeFSP.readFile(NodePath.join(directory, "pkg/ordinary.json"), "utf8"),
      );
      expect(
        report.testResults.map((suite: { name: string }) => NodePath.basename(suite.name)),
      ).toEqual(["Included.test.ts"]);

      const result = await cli("--group-size", "2", "pkg/Included.test.ts", "pkg/Excluded.test.ts");
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain("Excluded.test.ts");
      expect(result.stdout + result.stderr).not.toContain("unexpected excluded test execution");

      // The way check:changed runs a group, which may hold only excluded files.
      for (const files of [["./Included.test.ts", "./Excluded.test.ts"], ["./Excluded.test.ts"]]) {
        const changed = runGroup("pkg", "--allow-excluded", ...files, "--", "--passWithNoTests");
        expect(changed.status, changed.stdout + changed.stderr).toBe(0);
        expect(changed.stdout + changed.stderr).not.toContain("unexpected excluded test execution");
      }
      const failing = runGroup("pkg", "--allow-excluded", "./Excluded.test.ts", "--");
      expect(failing.status, failing.stdout + failing.stderr).toBe(1);
    }));

  const withTestPackage = (test: string, body: Parameters<typeof withFixture>[0]) =>
    withFixture(async (fixture) => {
      await NodeFSP.mkdir(NodePath.join(fixture.directory, "pkg"));
      await fixture.write(
        "pkg/package.json",
        JSON.stringify({ type: "module", scripts: { test } }),
      );
      await fixture.write("pkg/vite.config.ts", "export default {};");
      await body(fixture);
    });

  const recordExecution = `import {test} from "vite-plus/test";
    import {writeFileSync} from "node:fs";
    test("record execution", () => writeFileSync(import.meta.filename + ".ran", "ran"));`;
  const executionReceipt = (directory: string, file: string) =>
    NodeFSP.readFile(NodePath.join(directory, "pkg", file + ".ran"), "utf8");

  it.each([
    ["first", "second"],
    // These project names give Vitest's file tasks the same internal ID.
    ["Aa", "BB"],
  ])(
    "refuses to cache a file when only project %s ran and %s was skipped by the sequencer",
    (first, second) =>
      withTestPackage("vp test run --passWithNoTests", async ({ write, cli, hits }) => {
        await write(
          "pkg/vite.config.ts",
          `import {BaseSequencer} from "vite-plus/test/node";
        class FirstOnly extends BaseSequencer {
          sort(specs) { return specs.filter(spec => spec.project.name === ${JSON.stringify(first)}); }
        }
        export default {test:{sequence:{sequencer:FirstOnly},projects:[
          {test:{name:${JSON.stringify(first)},include:["*.test.ts"]}},
          {test:{name:${JSON.stringify(second)},include:["*.test.ts"]}}
        ]}};`,
        );
        await write("pkg/Shared.test.ts", recordExecution);
        for (const result of [await cli("pkg/Shared.test.ts"), await cli("pkg/Shared.test.ts")]) {
          expect(result.status, result.stdout + result.stderr).toBe(1);
          expect(result.stdout + result.stderr).toContain(
            "did not complete the requested test group",
          );
        }
        expect(await hits()).toBe(0);
      }),
  );

  it("caches completed projects with colliding task IDs when each completion can be identified", () =>
    withTestPackage(
      "vp test run --no-file-parallelism",
      async ({ directory, write, cli, hits }) => {
        await write(
          "pkg/vite.config.ts",
          `export default {test:{projects:[
        {test:{name:"Aa",sequence:{groupOrder:1}}},
        {test:{name:"BB",sequence:{groupOrder:2}}}
      ]}};`,
        );
        await write(
          "pkg/Shared.test.ts",
          'import {test} from "vite-plus/test"; import {writeFileSync} from "node:fs"; test("project", ({task}) => writeFileSync(task.file.projectName + ".ran", "ran"));',
        );
        const cold = await cli("pkg/Shared.test.ts");
        expect(cold.status, cold.stdout + cold.stderr).toBe(0);
        for (const name of ["Aa", "BB"])
          expect(await executionReceipt(directory, name)).toBe("ran");
        expect(await hits()).toBe(0);
        const repeat = await cli("pkg/Shared.test.ts");
        expect(repeat.status, repeat.stdout + repeat.stderr).toBe(0);
        expect(await hits()).toBe(1);
      },
    ));

  it("applies both configured and command-line excludes before caching a requested file", () =>
    withTestPackage(
      "vp test run --passWithNoTests --exclude '**/CliExcluded.test.ts'",
      async ({ directory, write, cli }) => {
        await write(
          "pkg/vite.config.ts",
          'export default {test:{exclude:["**/ConfigExcluded.test.ts"]}};',
        );
        for (const file of ["ConfigExcluded.test.ts", "CliExcluded.test.ts"]) {
          await write("pkg/" + file, recordExecution);
          const result = await cli("pkg/" + file);
          expect(result.error).toBeUndefined();
          expect(result.status, result.stdout + result.stderr).toBe(1);
          await expect(executionReceipt(directory, file)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
    ));

  it("intersects package positional filters with the requested cached files", () =>
    withTestPackage("vp test run choice", async ({ directory, write, cli }) => {
      await write("pkg/choiceSelected.test.ts", recordExecution);
      await write("pkg/choiceSibling.test.ts", 'throw new Error("Unrequested package match ran");');
      await write("pkg/other.test.ts", recordExecution);

      const selected = await cli("pkg/choiceSelected.test.ts");
      expect(selected.status, selected.stdout + selected.stderr).toBe(0);
      expect(await executionReceipt(directory, "choiceSelected.test.ts")).toBe("ran");
      const outside = await cli("pkg/other.test.ts");
      expect(outside.error).toBeUndefined();
      expect(outside.status, outside.stdout + outside.stderr).toBe(1);
      await expect(executionReceipt(directory, "other.test.ts")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  it("keeps trailing package arguments out of Vitest's file filters", () =>
    withTestPackage(
      "vp test run First.test.ts -- Second.test.ts",
      async ({ directory, write, packageTest, cli, hits }) => {
        await write("pkg/First.test.ts", recordExecution);
        await write("pkg/Second.test.ts", recordExecution);
        const ordinary = packageTest("pkg", "First.test.ts", "--", "Second.test.ts");
        expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0);
        expect(await executionReceipt(directory, "First.test.ts")).toBe("ran");
        const outside = await cli("pkg/Second.test.ts");
        expect(outside.status, outside.stdout + outside.stderr).toBe(1);
        await expect(executionReceipt(directory, "Second.test.ts")).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await hits()).toBe(0);
      },
    ));

  it("validates package file-and-line filters before selecting one cache group", () =>
    withTestPackage(
      "vp test run First.test.ts:2 Second.test.ts:2",
      async ({ directory, write, packageTest, cli }) => {
        const test =
          'import {test} from "vite-plus/test"; import {writeFileSync} from "node:fs";\ntest("selected line", () => writeFileSync(import.meta.filename + ".ran", "ran"));\ntest("other line", () => { throw new Error("unselected line ran") });';
        for (const file of ["First.test.ts", "Second.test.ts"]) await write("pkg/" + file, test);
        const ordinary = packageTest("pkg", "First.test.ts:2", "Second.test.ts:2");
        expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0);
        for (const file of ["First.test.ts", "Second.test.ts"]) {
          expect(await executionReceipt(directory, file)).toBe("ran");
          await NodeFSP.unlink(NodePath.join(directory, "pkg", file + ".ran"));
        }
        const result = await cli("pkg/First.test.ts");
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(await executionReceipt(directory, "First.test.ts")).toBe("ran");
        await expect(executionReceipt(directory, "Second.test.ts")).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    ));

  it("loads the package config with the same runtime environment as vp test", () =>
    withTestPackage(
      "vp test run",
      async ({ directory, runtimeEnv, write, packageTest, cli, hits }) => {
        await write(
          "pkg/vite.config.ts",
          `import {writeFileSync} from "node:fs";
        const {JS_RUNTIME_NAME, JS_RUNTIME_VERSION, NODE_PACKAGE_MANAGER} = process.env;
        writeFileSync("runtime.json", JSON.stringify([JS_RUNTIME_NAME, JS_RUNTIME_VERSION, NODE_PACKAGE_MANAGER]));
        const ready = NODE_PACKAGE_MANAGER !== undefined && process.env.TEST === "true" && process.env.VITEST === "true" && process.env.NODE_ENV === "test";
        export default {test:{include:ready ? ["*.test.ts"] : []}};`,
        );
        await write("pkg/Selected.test.ts", recordExecution);
        const runtimeFile = NodePath.join(directory, "pkg/runtime.json");
        const ordinary = packageTest("pkg", "Selected.test.ts");
        expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0);
        const runtime = JSON.parse(await NodeFSP.readFile(runtimeFile, "utf8"));
        expect(runtime).toEqual(["node", expect.stringMatching(/^\d+\./), "vite-plus"]);
        await NodeFSP.unlink(runtimeFile);
        await NodeFSP.unlink(NodePath.join(directory, "pkg/Selected.test.ts.ran"));
        const result = await cli("pkg/Selected.test.ts");
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(JSON.parse(await NodeFSP.readFile(runtimeFile, "utf8"))).toEqual(runtime);
        expect(await executionReceipt(directory, "Selected.test.ts")).toBe("ran");
        const shardReport = NodePath.join(directory, "shard-report.json");
        const shard = await cli("--shard", "1/1", "pkg", "--report", shardReport);
        expect(shard.status, shard.stdout + shard.stderr).toBe(0);
        expect(JSON.parse(await NodeFSP.readFile(shardReport, "utf8")).files).toEqual([
          "pkg/Selected.test.ts",
        ]);
        runtimeEnv.JS_RUNTIME_NAME = "";
        runtimeEnv.JS_RUNTIME_VERSION = "custom version";
        runtimeEnv.NODE_PACKAGE_MANAGER = "custom manager";
        const overridden = packageTest("pkg", "Selected.test.ts");
        expect(overridden.status, overridden.stdout + overridden.stderr).toBe(0);
        const expected = JSON.parse(await NodeFSP.readFile(runtimeFile, "utf8"));
        expect(expected).toEqual(["", "custom version", "custom manager"]);
        await NodeFSP.unlink(runtimeFile);
        const changed = await cli("pkg/Selected.test.ts");
        expect(changed.status, changed.stdout + changed.stderr).toBe(0);
        expect(await hits()).toBe(0);
        expect(JSON.parse(await NodeFSP.readFile(runtimeFile, "utf8"))).toEqual(expected);
      },
    ));

  it("rejects an unknown nested Vitest option before running a cached test", () =>
    withTestPackage("vp test run --sequence.shufle=true", async ({ directory, write, cli }) => {
      await write("pkg/a.test.ts", recordExecution);
      const result = await cli("pkg/a.test.ts");
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain("shufle");
      await expect(executionReceipt(directory, "a.test.ts")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  it("uses Vitest's configured teardown timeout when a reporter keeps an interval open", () =>
    withTestPackage("vp test run", async ({ directory, write, cli }) => {
      await write(
        "pkg/vite.config.ts",
        'export default {test:{teardownTimeout:250,reporters:["./reporter.mjs"]}};',
      );
      await write(
        "pkg/reporter.mjs",
        `import {writeFileSync} from "node:fs";
        export default class {
          onTestRunEnd() {
            const interval = setInterval(() => {}, 1000);
            setTimeout(() => { clearInterval(interval); process.exitCode = 29; }, 5000).unref();
          }
          onProcessTimeout() { writeFileSync("teardown.ran", "ran"); }
        }`,
      );
      await write("pkg/keepalive.test.ts", recordExecution);

      const result = await cli("pkg/keepalive.test.ts");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(await executionReceipt(directory, "teardown")).toBe("ran");
    }));

  it("uses filesystem identity for a Greek sigma selection and its cache exception", () =>
    withFixture(async ({ directory, write, cli }) => {
      const disk = "οσ-1.test.ts";
      const alias = "ΟΣ-1.test.ts";
      await write(disk, 'import {test} from "vite-plus/test"; test("selected", () => {});');
      const equivalent = await NodeFSP.access(NodePath.join(directory, alias)).then(
        () => true,
        () => false,
      );
      const report = NodePath.join(directory, "selected.json");
      const result = await cli("--report", report, "--uncached", alias, alias);
      if (!equivalent) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("No test files matched");
        return;
      }
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const recorded = JSON.parse(await NodeFSP.readFile(report, "utf8"));
      expect(recorded.files).toEqual([disk]);
      expect(
        recorded.summary.tasks.filter((task: { task_name: string }) =>
          task.task_name.includes("test-cache:"),
        ),
      ).toMatchObject([{ result: { Spawned: { cache_status: "Disabled" } } }]);
    }));

  it("reuses individual results and invalidates filesystem inputs", () =>
    withFixture(async ({ write, run, hits }) => {
      expect(await run()).toBe(0);
      expect(await hits()).toBe(0);
      await write("fixture.txt", "hello changed");
      expect(await run()).toBe(0);
      expect(await hits()).toBe(1);
    }));

  it("never caches failures", () =>
    withFixture(async ({ write, run, hits }) => {
      expect(await run()).toBe(0);
      await write("fixture.txt", "broken");
      expect(await run()).toBe(1);
      expect(await run()).toBe(1);
      expect(await hits()).toBe(1);
    }));

  it("runs uncached files every time", () =>
    withFixture(async ({ directory, write, run }) => {
      await write(
        "b.test.ts",
        'import {test} from "vite-plus/test";import {writeFileSync} from "node:fs";test("report",()=>writeFileSync("report.json","{}"));',
      );
      expect(await run(undefined, ["b.test.ts"])).toBe(0);
      await NodeFSP.unlink(NodePath.join(directory, "report.json"));
      expect(await run(undefined, ["b.test.ts"])).toBe(0);
      expect(await NodeFSP.readFile(NodePath.join(directory, "report.json"), "utf8")).toBe("{}");
    }));
});

// Each row is one Git process's trace2 perf events, with `checkout` this checkout and `other` a
// folder outside it.
describe("readsCheckoutGit", () => {
  const quotePerf = (word: string) =>
    /^[A-Za-z0-9+,\-./:=@^_]+$/.test(word)
      ? word
      : `'${word.replaceAll("'", "'\\''").replaceAll("!", "'\\!'")}'`;
  const perf = (event: string, payload: string, full = false) =>
    `${full ? "21:03:24.371788 common-init.c:78             | " : ""}d0 | main                     | ${event.padEnd(12)} |     |           |           |              | ${payload}`;
  const start = (...argv: Array<string>) => perf("start", argv.map(quotePerf).join(" "));
  const repo = (worktree: string) => perf("def_repo", `worktree:${quotePerf(worktree)}`);
  const param = (name: string, value: string) => perf("def_param", `${name}:${value}`);

  it.each<
    [
      string,
      boolean,
      (checkout: string, other: string) => Array<string>,
      ((
        checkout: string,
        other: string,
      ) => {
        checkoutPaths?: Array<string>;
        cwd?: string;
        platform?: NodeJS.Platform;
        eol?: string;
      })?,
    ]
  >([
    ["upload-pack serving the checkout", true, (checkout) => [start("git-upload-pack", checkout)]],
    [
      "upload-pack in a linked worktree's git dir",
      true,
      (checkout) => [repo(NodePath.join(checkout, ".git", "worktrees", "linked"))],
    ],
    [
      "upload-pack with an unnormalized path through a deleted temp cwd",
      true,
      (checkout, other) => [
        start("git-upload-pack", `${other}/deleted/../../${NodePath.basename(checkout)}/.git`),
      ],
    ],
    [
      "full (non-brief) trace2 perf lines with CRLF",
      true,
      (checkout) => [perf("start", `git-upload-pack ${quotePerf(checkout)}`, true)],
      () => ({ eol: "\r\n" }),
    ],
    [
      "--git-dir naming the checkout's git dir",
      true,
      (checkout, other) => [
        start("git", `--git-dir=${NodePath.join(checkout, ".git")}`, "log"),
        repo(other),
      ],
    ],
    [
      "a relative GIT_DIR from another repository",
      true,
      (checkout, other) => [
        start("git", "log"),
        param("GIT_DIR", NodePath.relative(other, NodePath.join(checkout, ".git"))),
        repo(other),
      ],
    ],
    [
      "--bare --git-dir=.git in a linked worktree",
      true,
      () => [start("git", "--bare", "--git-dir=.git", "rev-parse", "HEAD")],
      (checkout, other) => ({
        checkoutPaths: [
          checkout,
          NodePath.join(other, "common.git", "worktrees", "linked"),
          NodePath.join(other, "common.git"),
        ],
        cwd: checkout,
      }),
    ],
    [
      "relative path from a package subdirectory inside the checkout",
      true,
      () => [start("git", "ls-remote", "../..")],
      (checkout) => ({ cwd: NodePath.join(checkout, "apps", "server") }),
    ],
    [
      "relative --git-dir from a package subdirectory inside the checkout",
      true,
      () => [start("git", "--bare", "--git-dir=../../.git", "rev-parse", "HEAD")],
      (checkout) => ({ cwd: NodePath.join(checkout, "apps", "server") }),
    ],
    [
      "relative path from an ancestor directory between cwd and checkout",
      true,
      () => [start("git", "ls-remote", "..")],
      (checkout) => ({ cwd: NodePath.join(checkout, "apps", "server") }),
    ],
    [
      "non-checkout relative args from a package subdirectory",
      false,
      () => [start("git", "hash-object", "src/a.ts")],
      (checkout) => ({ cwd: NodePath.join(checkout, "apps", "server") }),
    ],
    [
      "C-quoted GIT_ALTERNATE_OBJECT_DIRECTORIES with embedded delimiter pointing at the checkout",
      true,
      (checkout, other) => [
        start("git", "rev-parse", "--git-dir"),
        param(
          "GIT_ALTERNATE_OBJECT_DIRECTORIES",
          `"${other.replaceAll("\\", "\\\\")}/a${NodePath.delimiter}b"${NodePath.delimiter}"${NodePath.join(checkout, ".git", "objects").replaceAll("\\", "\\\\")}"`,
        ),
        repo(other),
      ],
    ],
    [
      "C-quoted GIT_ALTERNATE_OBJECT_DIRECTORIES pointing only outside the checkout",
      false,
      (_, other) => [
        start("git", "rev-parse", "--git-dir"),
        param(
          "GIT_ALTERNATE_OBJECT_DIRECTORIES",
          `"${other.replaceAll("\\", "\\\\")}/a${NodePath.delimiter}b"${NodePath.delimiter}"${other.replaceAll("\\", "\\\\")}/c\\040d"`,
        ),
        repo(other),
      ],
    ],
    [
      "malformed unclosed quote in GIT_ALTERNATE_OBJECT_DIRECTORIES",
      true,
      (_, other) => [
        start("git", "rev-parse", "--git-dir"),
        param("GIT_ALTERNATE_OBJECT_DIRECTORIES", `"${other}/unclosed`),
        repo(other),
      ],
    ],
    [
      "Windows file:///C:/... URL pointing at the checkout",
      true,
      () => [start("git", "clone", "file:///C:/Work/Repo")],
      () => ({
        checkoutPaths: ["C:\\Work\\Repo", "C:\\Work\\Repo\\.git"],
        cwd: "C:\\Other",
        platform: "win32",
      }),
    ],
    [
      "Windows unnormalized forward-slash path with case differences",
      true,
      () => [start("git-upload-pack", "c:/work/deleted/../repo/.git")],
      () => ({
        checkoutPaths: ["C:\\Work\\Repo", "C:\\Work\\Repo\\.git"],
        cwd: "C:\\Other",
        platform: "win32",
      }),
    ],
    [
      "macOS case-insensitive path matching",
      true,
      () => [start("git-upload-pack", "/USERS/DEV/WORK/REPO")],
      () => ({
        checkoutPaths: ["/Users/dev/Work/Repo", "/Users/dev/Work/Repo/.git"],
        cwd: "/Users/dev/Work/Repo",
        platform: "darwin",
      }),
    ],
    [
      "bare repository GIT_DIR:. without def_repo (such as git push to a temp bare remote)",
      false,
      () => [start("git", "unpack-objects"), param("GIT_DIR", ".")],
    ],
    [
      "relative GIT_DIR:.git without def_repo from a package subdirectory",
      true,
      () => [start("git", "rev-parse", "--git-dir"), param("GIT_DIR", "../../.git")],
      (checkout) => ({
        checkoutPaths: [checkout, NodePath.join(checkout, ".git")],
        cwd: NodePath.join(checkout, "apps", "server"),
      }),
    ],
    [
      "multiline alias and exec events in another repository",
      false,
      (_, other) => [
        perf("version", "2.56.1"),
        perf("alias", "alias:myalias argv:[\x27echo hi\necho bye\x27]"),
        perf("exec", "argv:[\x27echo a\nb\x27]"),
        repo(other),
      ],
    ],
    [
      "relative arguments, multiline commit message, and multiline error in another repository",
      false,
      (_, other) => [
        perf("version", "2.56.1"),
        start("git", "commit", "-m", "title\n\nbody with 'quote' and !bang"),
        repo(other),
        perf("error", "....first line\n\nsecond line"),
      ],
    ],
    [
      "quoted def_repo path with spaces, quotes, and bang inside the checkout",
      true,
      (checkout) => [repo(NodePath.join(checkout, "sub 'with' !bang"))],
    ],
    ["an empty start argv", true, () => [perf("start", "")]],
    ["a start line with an unclosed quote", true, () => [perf("start", "git 'unclosed")]],
    ["a repository without worktree prefix", true, () => [perf("def_repo", "")]],
    [
      "a truncated line after version",
      true,
      () => [perf("version", "2.56.1"), "d0 | main | def_re"],
    ],
  ])("tells whether %s reads the checkout: %s", (_, expected, events, configure) => {
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "trace-")));
    try {
      const checkout = NodePath.join(root, "checkout");
      const other = NodePath.join(root, "other");
      const traces = NodePath.join(root, "traces");
      NodeFS.mkdirSync(traces);
      const options = configure?.(checkout, other);
      NodeFS.writeFileSync(
        NodePath.join(traces, "process"),
        events(checkout, other).join(options?.eol ?? "\n"),
      );
      expect(
        readsCheckoutGit(
          traces,
          options?.checkoutPaths ?? [checkout, NodePath.join(checkout, ".git")],
          {
            cwd: options?.cwd,
            platform: options?.platform,
          },
        ),
      ).toBe(expected);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts an unparseable, empty, or discarded trace file as a read", () => {
    const traces = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "trace-"));
    try {
      NodeFS.writeFileSync(NodePath.join(traces, "process"), '{"event":"start","argv":[');
      expect(readsCheckoutGit(traces, [NodePath.join(traces, "checkout")])).toBe(true);
      NodeFS.writeFileSync(NodePath.join(traces, "process"), "");
      expect(readsCheckoutGit(traces, [NodePath.join(traces, "checkout")])).toBe(true);
      NodeFS.rmSync(NodePath.join(traces, "process"));
      NodeFS.writeFileSync(
        NodePath.join(traces, "git-trace2-discard"),
        [perf("version", "2.56.1"), repo(NodePath.join(traces, "other"))].join("\n"),
      );
      expect(readsCheckoutGit(traces, [NodePath.join(traces, "checkout")])).toBe(true);
    } finally {
      NodeFS.rmSync(traces, { recursive: true, force: true });
    }
  });

  it("detects a real git child via GIT_TRACE2_PERF even when GIT_TRACE2_EVENT is overwritten", () => {
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "trace-")));
    try {
      const checkout = NodePath.join(root, "checkout");
      const traces = NodePath.join(root, "traces");
      const eventFile = NodePath.join(root, "event.jsonl");
      NodeFS.mkdirSync(checkout);
      NodeFS.mkdirSync(traces);
      const baseEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      );
      NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: checkout, env: baseEnv });
      NodeChildProcess.execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: checkout,
        env: {
          ...baseEnv,
          GIT_TRACE2_PERF: traces,
          GIT_TRACE2_PERF_BRIEF: "1",
          GIT_TRACE2_EVENT: eventFile,
        },
      });
      expect(readsCheckoutGit(traces, [checkout, NodePath.join(checkout, ".git")])).toBe(true);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a real git push to a temp bare remote as reading the checkout", () => {
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "trace-")));
    try {
      const checkout = NodePath.join(root, "checkout");
      const remote = NodePath.join(root, "origin.git");
      const work = NodePath.join(root, "work");
      const traces = NodePath.join(root, "traces");
      NodeFS.mkdirSync(checkout);
      NodeFS.mkdirSync(work);
      NodeFS.mkdirSync(traces);
      const baseEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      );
      const runGit = (args: ReadonlyArray<string>, cwd: string, extraEnv?: NodeJS.ProcessEnv) =>
        NodeChildProcess.execFileSync("git", [...args], {
          cwd,
          env: {
            ...baseEnv,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
            ...extraEnv,
          },
        });
      runGit(["init", "-q"], checkout);
      runGit(["init", "-q", "--bare", remote], root);
      runGit(["init", "-q", "-b", "main"], work);
      NodeFS.writeFileSync(NodePath.join(work, "a.txt"), "hello\n");
      runGit(["add", "a.txt"], work);
      runGit(["commit", "-q", "-m", "init"], work);
      runGit(["push", "-q", remote, "HEAD:refs/heads/main"], work, {
        GIT_TRACE2_PERF: traces,
        GIT_TRACE2_PERF_BRIEF: "1",
        GIT_TRACE2_ENV_VARS:
          "GIT_DIR,GIT_COMMON_DIR,GIT_WORK_TREE,GIT_OBJECT_DIRECTORY,GIT_ALTERNATE_OBJECT_DIRECTORIES,GIT_INDEX_FILE",
        GIT_TRACE2_MAX_FILES: "0",
      });
      expect(
        readsCheckoutGit(traces, [checkout, NodePath.join(checkout, ".git")], { cwd: checkout }),
      ).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
