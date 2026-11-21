// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { isDarwinHost } from "@t3tools/shared/testing/hostPlatform";
import { expect, it } from "vite-plus/test";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

// Ad hoc codesign rewrites the binary it signs, and only macOS has codesign.
it.runIf(isDarwinHost)("signs a copy of the stage, so a retried package phase repeats", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-package-test-")),
  );
  try {
    const stageDir = NodePath.join(root, "stage");
    const contentDir = NodePath.join(stageDir, "t3-1.2.3-darwin-arm64");
    const stagedExecutable = NodePath.join(contentDir, "t3");
    NodeFS.mkdirSync(NodePath.join(contentDir, "node_modules", ".bin"), { recursive: true });
    NodeFS.copyFileSync("/usr/bin/true", stagedExecutable);
    NodeFS.symlinkSync("../tool/cli.js", NodePath.join(contentDir, "node_modules", ".bin", "tool"));
    const commit = NodeChildProcess.execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    NodeFS.writeFileSync(
      NodePath.join(stageDir, "stage.json"),
      JSON.stringify({ platform: "mac", arch: "arm64", version: "1.2.3", commit }),
    );
    const stagedBytes = NodeFS.readFileSync(stagedExecutable);

    for (const attempt of [1, 2]) {
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "scripts/build-cli-archive.ts",
          "--phase",
          "package",
          "--stage-dir",
          stageDir,
          "--platform",
          "mac",
          "--arch",
          "arm64",
          "--version",
          "1.2.3",
          "--output-dir",
          NodePath.join(root, "out"),
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          // Without T3CODE_CLI_MAC_SIGN_IDENTITY the package phase signs ad hoc.
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        },
      );
      expect(result.status, `attempt ${attempt}: ${result.stderr}${result.stdout}`).toBe(0);
      expect(NodeFS.readFileSync(stagedExecutable).equals(stagedBytes)).toBe(true);
    }

    const listing = NodeChildProcess.execFileSync(
      "tar",
      ["-tvzf", NodePath.join(root, "out", "t3-1.2.3-darwin-arm64.tar.gz")],
      { encoding: "utf8" },
    );
    expect(listing).toContain("node_modules/.bin/tool -> ../tool/cli.js");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
