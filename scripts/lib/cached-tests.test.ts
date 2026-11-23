// @effect-diagnostics nodeBuiltinImport:off - verifies native task caching in isolated subprocesses.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { cachedTestTasks, matchesTestPath, relativeTestPath } from "./cached-tests.ts";

describe("cachedTestTasks", () => {
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
      command: "vp test run 'src/worker.test.ts'",
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
  it("keeps a file's cache task stable when unrelated tests are added", () => {
    const first = cachedTestTasks(JSON.stringify({ files: ["src/b.test.ts"], groupSize: 1 }));
    const second = cachedTestTasks(
      JSON.stringify({ files: ["src/a.test.ts", "src/b.test.ts"], groupSize: 1 }),
    );
    const key = Object.keys(first).find((key) => key !== "test-cache")!;
    expect(second[key]).toEqual(first[key]);
  });

  it("keeps shell metacharacters in filenames out of the command", () => {
    const tasks = cachedTestTasks(
      JSON.stringify({ files: ["src/a'$(touch injected).test.ts"], groupSize: 1 }),
    );
    const task = Object.entries(tasks).find(([key]) => key !== "test-cache")![1];
    expect(task.command).toBe("vp test run 'src/a'\"'\"'$(touch injected).test.ts'");
  });

  it("rejects paths outside the checkout and empty groups", () => {
    for (const request of [
      { files: ["../elsewhere.test.ts"], groupSize: 1 },
      { files: ["/absolute.test.ts"], groupSize: 1 },
      { files: ["src/a.test.ts"], groupSize: 0 },
    ]) {
      expect(() => cachedTestTasks(JSON.stringify(request))).toThrow();
    }
  });

  it("accepts spec files discovered by Vitest", () => {
    const tasks = cachedTestTasks(JSON.stringify({ files: ["src/example.spec.ts"], groupSize: 1 }));
    expect(
      Object.values(tasks).some((task) => task.command === "vp test run 'src/example.spec.ts'"),
    ).toBe(true);
  });

  it("does not add tasks without an explicit request", () => {
    expect(cachedTestTasks(undefined)).toEqual({});
  });

  // Each `vp run` boots Vitest per task, so every behaviour is its own test with its own time budget.
  const withFixture = async (
    body: (fixture: {
      directory: string;
      write: (file: string, content: string) => Promise<void>;
      run: (files?: Array<string>, uncached?: Array<string>) => Promise<number | null>;
      cli: (...args: Array<string>) => Promise<NodeChildProcess.SpawnSyncReturns<string>>;
      hits: () => Promise<number>;
    }) => Promise<void>,
  ) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cached-tests-"));
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const write = (file: string, content: string) =>
      NodeFSP.writeFile(NodePath.join(directory, file), content);
    const cli = async (...args: Array<string>) => {
      const scripts = NodePath.join(directory, "scripts");
      await NodeFSP.mkdir(scripts, { recursive: true });
      for (const name of ["test-cached.ts", "check-changed-command.ts"]) {
        await NodeFSP.copyFile(NodePath.join(root, "scripts", name), NodePath.join(scripts, name));
      }
      await NodeFSP.symlink(import.meta.dirname, NodePath.join(scripts, "lib"), "junction");
      await write(".gitignore", "node_modules/\ncache/\nscripts/\n");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      );
      NodeChildProcess.execFileSync("git", ["init", "--quiet", directory], { env });
      return NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(scripts, "test-cached.ts"), ...args],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...env,
            NODE_OPTIONS: "",
            VP_REMOTE_CACHE: "off",
            VITE_CACHE_PATH: NodePath.join(directory, "cache"),
            PATH: `${NodePath.join(root, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH}`,
          },
          timeout: 30_000,
        },
      );
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
      await NodeFSP.symlink(
        await NodeFSP.realpath(NodePath.join(root, "node_modules/vite-plus")),
        NodePath.join(directory, "node_modules/vite-plus"),
        "junction",
      );
      await write("package.json", '{"type":"module"}');
      await write(
        "vite.config.ts",
        `import {cachedTestTasks} from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(root, "scripts/lib/cached-tests.ts")).href)}; export default {run:{tasks:cachedTestTasks(process.env.T3_CACHED_TESTS, import.meta.dirname)},test:{include:["*.test.ts"]}};`,
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
      await body({ directory, write, run, cli, hits });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };

  it("dispatches a dash-prefixed test path as the only Vitest filter", () =>
    withFixture(async ({ write, cli }) => {
      await write("a.test.ts", 'throw new Error("Unselected sibling was run");');
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
