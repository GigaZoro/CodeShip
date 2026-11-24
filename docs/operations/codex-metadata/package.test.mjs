import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { verifyPackage } from "./package.mjs";

for (const [target, suffix, platformHelpers] of [
  ["x86_64-unknown-linux-musl", "", ["codex-resources/bwrap"]],
  ["aarch64-apple-darwin", "", []],
  [
    "x86_64-pc-windows-msvc",
    ".exe",
    ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"],
  ],
]) {
  NodeTest.test(`verifies the ${target} CLI package and requires each native helper`, (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-metadata-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const cli = `bin/codex${suffix}`;
    const files = [
      cli,
      `bin/codex-code-mode-host${suffix}`,
      `codex-path/rg${suffix}`,
      ...platformHelpers,
    ];
    const manifest = {
      layoutVersion: 1,
      target,
      version: "0.172.0",
      variant: "codex",
      entrypoint: cli,
      pathDir: "codex-path",
      resourcesDir: "codex-resources",
    };
    const metadata = NodePath.join(root, "codex-package.json");
    NodeFS.writeFileSync(metadata, JSON.stringify(manifest));
    for (const name of files) {
      const file = NodePath.join(root, name);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "test binary", { mode: 0o755 });
    }
    verifyPackage(root, target);
    NodeFS.writeFileSync(metadata, JSON.stringify({ ...manifest, target: "wrong" }));
    NodeAssert.throws(() => verifyPackage(root, target), /target/);
    NodeFS.writeFileSync(metadata, JSON.stringify(manifest));
    for (const name of files) {
      NodeFS.rmSync(NodePath.join(root, name));
      NodeAssert.throws(() => verifyPackage(root, target), { message: new RegExp(name) });
      NodeFS.writeFileSync(NodePath.join(root, name), "test binary", { mode: 0o755 });
    }
  });
}
