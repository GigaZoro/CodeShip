// @effect-diagnostics nodeBuiltinImport:off -- The setup proof runs without workspace dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isDarwinHost, isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { expect, it } from "vite-plus/test";
import * as setup from "./worktree-setup-proof.ts";

it("reports a whole added cache subtree and rejects simultaneous edits to installed files", async () => {
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
      markerMetadataV1: await setup.sealSetupMarkers(cwd, "setup-done", signal),
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
    const astro = NodePath.join(cwd, "node_modules", ".astro");
    await NodeFSP.mkdir(astro);
    expect(await inspect()).toEqual(["node_modules/.astro", "node_modules/.vite-temp"]);
    // Older proofs could only attest to the first four cache names being absent.
    const oldProof = {
      ...proof,
      cacheSlots: { node_modules: proof.cacheSlots.node_modules! & 15 },
    };
    expect(await setup.inspectSetupProof(oldProof, cwd, status, signal)).toBeNull();
    const installedCache = {
      ...proof,
      ...(await setup.sealSetupTrees(cwd, ["node_modules"], signal)),
    };
    expect(await setup.inspectSetupProof(installedCache, cwd, status, signal)).toEqual([]);
    await NodeFSP.writeFile(NodePath.join(astro, "data-store.json"), "{}");
    expect(await setup.inspectSetupProof(installedCache, cwd, status, signal)).toBeNull();
    expect(await inspect()).toEqual(["node_modules/.astro", "node_modules/.vite-temp"]);
    expect(await setup.matchesSetupProof(proof, cwd, status, signal)).toBe(false);
    const original = await NodeFSP.stat(installed);
    await NodeFSP.writeFile(installed, "edits");
    await NodeFSP.utimes(installed, original.atime, original.mtime);
    expect(await inspect()).toBeNull();
  } finally {
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  }
});

it.skipIf(isWindowsHost)(
  "requires current POSIX metadata evidence for installed files and setup markers",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "setup-metadata-"));
    const signal = AbortSignal.timeout(30_000);
    try {
      const modules = NodePath.join(root, "node_modules");
      const installed = NodePath.join(modules, "installed.js");
      const markerDir = NodePath.join(root, ".t3");
      const done = NodePath.join(markerDir, "setup-done");
      const running = NodePath.join(markerDir, "setup-running");
      await NodeFSP.mkdir(modules);
      await NodeFSP.writeFile(installed, "installed");
      await NodeFSP.mkdir(markerDir);
      await NodeFSP.writeFile(running, "fixture");
      const proof = {
        root,
        checkout: "1/2/3/4/5/6",
        head: "a".repeat(40),
        links: [],
        marker: "3fde450a-8182-405c-aab1-551634a00012\n",
        ...(await setup.sealSetupTrees(root, ["node_modules"], signal)),
        markerMetadataV1: await setup.sealSetupMarkers(root, "setup-running", signal),
      };
      await NodeFSP.writeFile(done, proof.marker);
      await NodeFSP.unlink(running);
      const status = "!! .t3/\0!! node_modules/";
      const inspect = () => setup.inspectSetupProof(proof, root, status, signal);
      expect(await inspect()).toEqual([]);
      expect(
        await setup.inspectSetupProof(
          { ...proof, posixMetadataV1: undefined },
          root,
          status,
          signal,
        ),
      ).toBeNull();

      const run = NodeUtil.promisify(NodeChildProcess.execFile);
      for (const target of [installed, modules, markerDir, done]) {
        const name = "user.codeship_test";
        if (isDarwinHost) {
          await run("/usr/bin/xattr", ["-w", name, "fixture", target]);
          expect(await inspect()).toBeNull();
          expect((await run("/usr/bin/xattr", ["-p", name, target])).stdout.trim()).toBe("fixture");
          await run("/usr/bin/xattr", ["-d", name, target]);
        } else {
          await run("/usr/bin/python3", [
            "-I",
            "-c",
            "import os,sys; os.setxattr(sys.argv[1], sys.argv[2], b'fixture')",
            target,
            name,
          ]);
          expect(await inspect()).toBeNull();
          await run("/usr/bin/python3", [
            "-I",
            "-c",
            "import os,sys; assert os.getxattr(sys.argv[1], sys.argv[2]) == b'fixture'; os.removexattr(sys.argv[1], sys.argv[2])",
            target,
            name,
          ]);
        }
      }
      expect(await inspect()).toEqual([]);
      if (isDarwinHost) {
        // The task runner can substitute a portable chmod that lacks Darwin ACL operations.
        const nativeTool = (executable: string, args: string[]) =>
          run("/usr/bin/python3", [
            "-I",
            "-c",
            "import os, sys; os.execv(sys.argv[1], sys.argv[1:])",
            executable,
            ...args,
          ]);
        const acl = "everyone allow readattr";
        await nativeTool("/bin/chmod", ["+a", acl, installed]);
        expect((await nativeTool("/bin/ls", ["-le", installed])).stdout).toContain(acl);
        expect(await inspect()).toBeNull();
        await nativeTool("/bin/chmod", ["-a", acl, installed]);
        expect((await nativeTool("/bin/ls", ["-le", installed])).stdout).not.toContain(acl);
        expect(await inspect()).toEqual([]);
        await nativeTool("/usr/bin/chflags", ["hidden", modules]);
        expect(await inspect()).toBeNull();
        await nativeTool("/usr/bin/chflags", ["nohidden", modules]);
        const fork = installed + "/..namedfork/rsrc";
        await NodeFSP.writeFile(fork, "fixture");
        expect(await inspect()).toBeNull();
        expect(await NodeFSP.readFile(fork, "utf8")).toBe("fixture");
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
