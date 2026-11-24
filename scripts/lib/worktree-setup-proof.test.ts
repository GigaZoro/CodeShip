// @effect-diagnostics nodeBuiltinImport:off -- The setup proof runs without workspace dependencies.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as setup from "./worktree-setup-proof.ts";

it.skipIf(isWindowsHost)(
  "reports a whole added cache subtree and rejects simultaneous edits to installed files",
  async () => {
    const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "setup-proof-"));
    try {
      const installed = NodePath.join(cwd, "node_modules", "installed.js");
      const marker = "3fde450a-8182-405c-aab1-551634a00012\n";
      const signal = new AbortController().signal;
      await NodeFSP.mkdir(NodePath.dirname(installed));
      await NodeFSP.writeFile(installed, "setup");
      // Use whole seconds so restoring mtime does not lose filesystem precision.
      await NodeFSP.utimes(installed, 1, 1);
      await NodeFSP.mkdir(NodePath.join(cwd, ".t3"));
      await NodeFSP.writeFile(NodePath.join(cwd, ".t3", "setup-done"), marker);
      const existingCache = NodePath.join(cwd, "node_modules", ".cache");
      await NodeFSP.mkdir(existingCache);
      await NodeFSP.writeFile(NodePath.join(existingCache, "installed.txt"), "from setup");
      const proof = {
        root: cwd,
        checkout: "1/2/3/4/5/6",
        head: "a".repeat(40),
        links: [],
        marker,
        ...(await setup.sealSetupTrees(cwd, ["node_modules"], signal)),
      };
      const status = "!! .t3/\0!! node_modules/";
      const inspect = () => setup.inspectSetupProof(proof, cwd, status, signal);

      const alias = NodePath.join(cwd, "store-alias");
      await NodeFSP.link(installed, alias);
      expect(await inspect()).toEqual([]);
      await NodeFSP.unlink(alias);
      expect(await inspect()).toEqual([]);

      const cache = NodePath.join(cwd, "node_modules", ".vite-temp");
      await NodeFSP.mkdir(cache);
      await NodeFSP.writeFile(NodePath.join(cache, "personal.txt"), "keep this");
      expect(await inspect()).toEqual(["node_modules/.vite-temp"]);
      expect(await setup.matchesSetupProof(proof, cwd, status, signal)).toBe(false);
      const original = await NodeFSP.stat(installed);
      await NodeFSP.writeFile(installed, "edits");
      await NodeFSP.utimes(installed, original.atime, original.mtime);
      expect(await inspect()).toBeNull();
    } finally {
      await NodeFSP.rm(cwd, { recursive: true, force: true });
    }
  },
);
