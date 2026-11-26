// @effect-diagnostics nodeBuiltinImport:off -- These tests assert real POSIX modes on a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { prepareClerkTokenDirectory } from "./ClerkTokenStore.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Unix mode bits are the assertion; Windows reports them through ACLs.
const describePosix = describe.skipIf(process.platform === "win32");

const modeOf = (path: string): number => NodeFS.statSync(path).mode & 0o777;

function writeLoose(path: string, contents: string): void {
  NodeFS.writeFileSync(path, contents, { mode: 0o666 });
  NodeFS.chmodSync(path, 0o666);
}

async function withStateDir(run: (stateDir: string) => Promise<void> | void): Promise<void> {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-clerk-tokens-"));
  try {
    await run(stateDir);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
}

describePosix("ClerkTokenStore", () => {
  it("keeps clerk tokens at 0600 inside a 0700 directory", async () => {
    await withStateDir((stateDir) => {
      NodeFS.chmodSync(stateDir, 0o755);
      const directory = NodePath.join(stateDir, "clerk");
      const legacyPath = NodePath.join(stateDir, "clerk-tokens.json");
      const tokenPath = NodePath.join(directory, "clerk-tokens.json");
      NodeFS.mkdirSync(directory, { mode: 0o755 });
      NodeFS.chmodSync(directory, 0o755);
      writeLoose(legacyPath, '{"__clerk_client_jwt":"enc:existing"}\n');

      assert.equal(prepareClerkTokenDirectory(stateDir, "."), directory);
      assert.equal(modeOf(stateDir), 0o755);
      assert.equal(modeOf(directory), 0o700);
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.existsSync(legacyPath), false);
      assert.equal(
        NodeFS.readFileSync(tokenPath, "utf8"),
        '{"__clerk_client_jwt":"enc:existing"}\n',
      );

      writeLoose(tokenPath, "kept");
      writeLoose(legacyPath, "stale");
      NodeFS.chmodSync(directory, 0o755);
      prepareClerkTokenDirectory(stateDir, ".");
      assert.equal(modeOf(directory), 0o700);
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.existsSync(legacyPath), false);
      assert.equal(NodeFS.readFileSync(tokenPath, "utf8"), "kept");
    });
  });

  it("resolves a relative state directory before opening storage", async () => {
    await withStateDir((stateDir) => {
      const relativeStateDir = NodePath.relative(process.cwd(), stateDir);
      const opened = prepareClerkTokenDirectory(relativeStateDir, ".");
      const directory = NodePath.join(stateDir, "clerk");
      assert.equal(NodePath.isAbsolute(relativeStateDir), false);
      assert.equal(opened, directory);
      assert.equal(modeOf(directory), 0o700);
    });
  });

  it("migrates relative state paths from Electron userData, not the working directory", async () => {
    await withStateDir((stateDir) => {
      const relativeStateDir = NodePath.relative(process.cwd(), stateDir);
      const userData = NodePath.join(
        stateDir,
        "electron",
        ...relativeStateDir.split(NodePath.sep).map(() => "profile"),
      );
      const legacyStateDir = NodePath.join(userData, relativeStateDir);
      const legacyPath = NodePath.join(legacyStateDir, "clerk-tokens.json");
      NodeFS.mkdirSync(legacyStateDir, { recursive: true });
      writeLoose(legacyPath, "existing-session");
      const unrelatedPath = NodePath.join(stateDir, "clerk-tokens.json");
      writeLoose(unrelatedPath, "not-the-electron-session");

      prepareClerkTokenDirectory(relativeStateDir, userData);

      const tokenPath = NodePath.join(stateDir, "clerk", "clerk-tokens.json");
      assert.equal(NodeFS.readFileSync(tokenPath, "utf8"), "existing-session");
      assert.equal(modeOf(tokenPath), 0o600);
      assert.equal(NodeFS.existsSync(legacyPath), false);
      assert.equal(NodeFS.readFileSync(unrelatedPath, "utf8"), "not-the-electron-session");
    });
  });

  it("does not follow a symlinked clerk directory or token file", async () => {
    await withStateDir((stateDir) => {
      const outsideDirectory = NodePath.join(stateDir, "outside-dir");
      NodeFS.mkdirSync(outsideDirectory, { mode: 0o755 });
      NodeFS.chmodSync(outsideDirectory, 0o755);
      NodeFS.symlinkSync(outsideDirectory, NodePath.join(stateDir, "clerk"));

      assert.throws(() => prepareClerkTokenDirectory(stateDir, "."), /must be a real directory/);
      assert.equal(modeOf(outsideDirectory), 0o755);
      NodeFS.unlinkSync(NodePath.join(stateDir, "clerk"));

      const outsideFile = NodePath.join(stateDir, "outside.json");
      NodeFS.writeFileSync(outsideFile, "secret", { mode: 0o644 });
      NodeFS.chmodSync(outsideFile, 0o644);
      NodeFS.symlinkSync(outsideFile, NodePath.join(stateDir, "clerk-tokens.json"));
      assert.throws(() => prepareClerkTokenDirectory(stateDir, "."), /must be a regular file/);
      assert.equal(modeOf(outsideFile), 0o644);
    });
  });
});
