import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { GIT_OUTPUT_MAX_BYTES } from "../.github/scripts/git-history.cjs";
import {
  NEEDS_RUN_SKIP_EXIT_CODE,
  checkUpstreamDrift,
  detectSecurityAdvisories,
  exitCodeForResult,
  parseLegacyMergeTreeOutput,
} from "./upstream-drift-radar.mjs";

const SCRIPT_PATH = NodeURL.fileURLToPath(new URL("./upstream-drift-radar.mjs", import.meta.url));

function gitIn(cwd, ...args) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function withFixtureRepo(fn) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-drift-radar-test-"));
  try {
    gitIn(dir, "init", "-b", "main");
    gitIn(dir, "config", "user.email", "test@codeship.local");
    gitIn(dir, "config", "user.name", "CodeShip Test");
    NodeFS.writeFileSync(NodePath.join(dir, "shared.txt"), "line 1\n");
    gitIn(dir, "add", "shared.txt");
    gitIn(dir, "commit", "-m", "initial commit");
    return fn(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

describe("upstream-drift-radar", () => {
  it("skips with exit 10 when base already contains upstream", () => {
    withFixtureRepo((dir) => {
      gitIn(dir, "branch", "upstream-main");
      const result = checkUpstreamDrift({
        cwd: dir,
        base: "main",
        upstream: "upstream-main",
        fetch: false,
      });
      expect(result).toMatchObject({
        ok: true,
        needs_run: false,
        status: "up-to-date",
        behindCount: 0,
        conflicts: [],
      });
      expect(exitCodeForResult(result, true)).toBe(NEEDS_RUN_SKIP_EXIT_CODE);
    });
  });

  it("skips with 0-LLM exit 10 when upstream merges cleanly without advisories", () => {
    withFixtureRepo((dir) => {
      gitIn(dir, "checkout", "-b", "upstream-main");
      NodeFS.writeFileSync(NodePath.join(dir, "upstream-only.txt"), "hello upstream\n");
      gitIn(dir, "add", "upstream-only.txt");
      gitIn(dir, "commit", "-m", "feat: add upstream feature");

      gitIn(dir, "checkout", "main");
      NodeFS.writeFileSync(NodePath.join(dir, "fork-only.txt"), "hello fork\n");
      gitIn(dir, "add", "fork-only.txt");
      gitIn(dir, "commit", "-m", "feat: add fork feature");

      const result = checkUpstreamDrift({
        cwd: dir,
        base: "main",
        upstream: "upstream-main",
        fetch: false,
      });
      expect(result).toMatchObject({
        ok: true,
        needs_run: false,
        status: "clean",
        behindCount: 1,
        mergeMethod: "write-tree",
        conflicts: [],
        advisories: [],
      });
      expect(result.treeOid).toMatch(/^[0-9a-f]{40}$/);
      expect(exitCodeForResult(result, true)).toBe(NEEDS_RUN_SKIP_EXIT_CODE);

      const cli = NodeChildProcess.spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--needs-run",
          "--no-fetch",
          "--cwd",
          dir,
          "--base",
          "main",
          "--upstream",
          "upstream-main",
        ],
        { encoding: "utf8", maxBuffer: GIT_OUTPUT_MAX_BYTES },
      );
      expect(cli.status).toBe(NEEDS_RUN_SKIP_EXIT_CODE);
      const parsed = JSON.parse(cli.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.needs_run).toBe(false);
    });
  });

  it("triggers with exit 0 when git merge-tree detects a conflict", () => {
    withFixtureRepo((dir) => {
      gitIn(dir, "checkout", "-b", "upstream-main");
      NodeFS.writeFileSync(NodePath.join(dir, "shared.txt"), "upstream edit\n");
      gitIn(dir, "commit", "-am", "chore: upstream edits shared");

      gitIn(dir, "checkout", "main");
      NodeFS.writeFileSync(NodePath.join(dir, "shared.txt"), "fork edit\n");
      gitIn(dir, "commit", "-am", "chore: fork edits shared");

      const cli = NodeChildProcess.spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--needs-run",
          "--no-fetch",
          "--cwd",
          dir,
          "--base",
          "main",
          "--upstream",
          "upstream-main",
        ],
        { encoding: "utf8", maxBuffer: GIT_OUTPUT_MAX_BYTES },
      );
      expect(cli.status).toBe(0);
      const parsed = JSON.parse(cli.stdout.trim());
      expect(parsed).toMatchObject({
        ok: true,
        needs_run: true,
        status: "conflicts",
        behindCount: 1,
        conflicts: ["shared.txt"],
      });
      expect(parsed.reason).toContain("shared.txt");
    });
  });

  it("triggers with exit 0 on a clean merge when an upstream commit mentions a security advisory", () => {
    withFixtureRepo((dir) => {
      gitIn(dir, "checkout", "-b", "upstream-main");
      NodeFS.writeFileSync(NodePath.join(dir, "auth.txt"), "patched\n");
      gitIn(dir, "add", "auth.txt");
      gitIn(dir, "commit", "-m", "fix(security): patch CVE-2026-42421 token bypass");
      gitIn(dir, "checkout", "main");

      const result = checkUpstreamDrift({
        cwd: dir,
        base: "main",
        upstream: "upstream-main",
        fetch: false,
      });
      expect(result).toMatchObject({
        ok: true,
        needs_run: true,
        status: "security-advisory",
        conflicts: [],
      });
      expect(result.advisories).toHaveLength(1);
      expect(result.advisories[0].matches).toContain("CVE-2026-42421");
      expect(exitCodeForResult(result, true)).toBe(0);
    });
  });

  it("runs optional isolated worktree verification and triggers only on failure", () => {
    withFixtureRepo((dir) => {
      gitIn(dir, "checkout", "-b", "upstream-main");
      NodeFS.writeFileSync(NodePath.join(dir, "upstream-ok.txt"), "ok\n");
      gitIn(dir, "add", "upstream-ok.txt");
      gitIn(dir, "commit", "-m", "feat: clean upstream change");
      gitIn(dir, "checkout", "main");

      const passResult = checkUpstreamDrift({
        cwd: dir,
        base: "main",
        upstream: "upstream-main",
        fetch: false,
        verify: true,
        verifyCommand: [
          process.execPath,
          "-e",
          'const fs=require("node:fs"); process.exit(fs.existsSync("upstream-ok.txt") ? 0 : 1);',
        ],
      });
      expect(passResult).toMatchObject({
        ok: true,
        needs_run: false,
        status: "clean",
        verification: { ok: true, status: 0 },
      });

      const failResult = checkUpstreamDrift({
        cwd: dir,
        base: "main",
        upstream: "upstream-main",
        fetch: false,
        verify: true,
        verifyCommand: [process.execPath, "-e", 'console.error("tsc failed"); process.exit(2);'],
      });
      expect(failResult).toMatchObject({
        ok: true,
        needs_run: true,
        status: "verification-failed",
        verification: { ok: false, status: 2 },
      });
      expect(failResult.reason).toContain("tsc failed");

      const worktreeList = gitIn(dir, "worktree", "list", "--porcelain");
      expect(worktreeList.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(
        1,
      );
    });
  });

  it("falls back to legacy 3-way git merge-tree when --write-tree is unsupported", () => {
    const calls = [];
    const runner = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "rev-parse" && args[2] === "origin/main") {
        return { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse" && args[2] === "upstream/main") {
        return { status: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { status: 0, stdout: "2\n", stderr: "" };
      }
      if (args[0] === "log") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-tree" && args[1] === "--write-tree") {
        return { status: 129, stdout: "", stderr: "error: unknown option `write-tree'" };
      }
      if (args[0] === "merge-base") {
        return { status: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      }
      if (args[0] === "merge-tree") {
        return {
          status: 0,
          stdout: [
            "changed in both",
            "  base   100644 1111111 src/app.ts",
            "  our    100644 2222222 src/app.ts",
            "  their  100644 3333333 src/app.ts",
            "+<<<<<<< .our",
            "+fork",
            "+=======",
            "+upstream",
            "+>>>>>>> .their",
          ].join("\n"),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected call: ${args.join(" ")}` };
    };

    const result = checkUpstreamDrift({
      cwd: "/fake/repo",
      fetch: false,
      runCommand: runner,
    });
    expect(result).toMatchObject({
      ok: true,
      needs_run: true,
      status: "conflicts",
      mergeMethod: "legacy-3way",
      conflicts: ["src/app.ts"],
    });
    expect(
      calls.some(
        (call) => call[0] === "git" && call[1] === "merge-tree" && call[2] !== "--write-tree",
      ),
    ).toBe(true);
  });

  it("parses security advisories and legacy merge-tree output cleanly", () => {
    const advisories = detectSecurityAdvisories(
      [
        "1234567890abcdef\x1ffeat: normal commit\x1fNo security issue\x1e",
        "fedcba0987654321\x1fchore: bump dep\x1fFixes GHSA-abcd-1234-ef56\x1e",
      ].join(""),
    );
    expect(advisories).toEqual([
      {
        commit: "fedcba098765",
        subject: "chore: bump dep",
        matches: ["GHSA-abcd-1234-ef56"],
      },
    ]);

    expect(
      parseLegacyMergeTreeOutput(
        "merged\n  result 100644 1234567 clean.ts\nadded in both\n  our 100644 1234567 dup.ts\n",
      ),
    ).toEqual(["dup.ts"]);
  });
});
