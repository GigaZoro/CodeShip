// @effect-diagnostics nodeBuiltinImport:off - scans the repository's Vite configs on disk.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveTestMaxWorkers } from "./test-workers.ts";

const root = NodePath.resolve(import.meta.dirname, "../..");

describe("resolveTestMaxWorkers", () => {
  it.each([
    [{}, 18, 2],
    [{}, 1, 1],
    [{ CI: "true" }, 4, 4],
    [{ T3CODE_TEST_MAX_WORKERS: "6" }, 18, 6],
    [{ CI: "true", T3CODE_TEST_MAX_WORKERS: "1" }, 4, 1],
    [{ T3CODE_TEST_MAX_WORKERS: "0" }, 18, 2],
    [{ T3CODE_TEST_MAX_WORKERS: "abc" }, 18, 2],
  ])("env %j on %i cores allows %i workers", (env, cores, expected) => {
    expect(resolveTestMaxWorkers(env, cores)).toBe(expected);
  });
});

describe("vitest configs", () => {
  // A config without `maxWorkers: TEST_MAX_WORKERS` lets vitest start one worker per core, and
  // concurrent worktree runs then multiply that past the machine.
  it("every tracked Vite config that defines tests caps its workers at the shared constant", () => {
    const tracked = NodeFS.globSync("{,apps/*/,packages/*/}vite.config.ts", { cwd: root });
    const uncapped = tracked.filter((file) => {
      const source = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
      // The server config inherits the root config's test block, which carries the cap.
      const inheritsRoot = /import baseConfig from "\.\.\/\.\.\/vite\.config\.ts"/.test(source);
      const capped = inheritsRoot || /maxWorkers:\s*TEST_MAX_WORKERS\b/.test(source);
      return /\btest:\s*\{/.test(source) && !capped;
    });
    expect(tracked.length).toBeGreaterThan(4);
    expect(uncapped).toEqual([]);
  });
});
