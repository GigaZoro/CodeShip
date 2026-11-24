// @effect-diagnostics nodeBuiltinImport:off -- Native stamps are part of the worktree setup proof.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  sealSetupTrees,
  setupFileStamp,
  writeSetupProof,
} from "../../../../scripts/lib/worktree-setup-proof.ts";
import { layerRealGit } from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  decodeReleaseRequest,
  listWorktreeBackups,
  queueWorktreeRelease,
  releaseHold,
} from "./worktreeRelease.ts";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);

const sealedCheckout = (options: { inPlace?: true } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitDriver = yield* GitVcsDriver.GitVcsDriver;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-release-" }),
    );
    const project = path.join(root, "project");
    const checkout = path.join(root, "worktree");
    const git = (cwd: string, ...args: string[]) =>
      gitDriver
        .execute({ operation: "test.worktreeRelease", cwd, args })
        .pipe(Effect.map(({ stdout }) => stdout.trimEnd()));
    yield* git(root, "init", "-b", "main", project);
    yield* fs.writeFileString(
      path.join(project, ".gitignore"),
      "node_modules/\n.t3/\ndist/\n.env\n",
    );
    yield* git(project, "add", ".gitignore");
    yield* git(
      project,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    );
    yield* git(project, "worktree", "add", "-b", "feature", checkout);
    const modules = path.join(checkout, "node_modules");
    yield* fs.makeDirectory(modules);
    yield* fs.writeFileString(path.join(modules, "installed.js"), "package contents");
    yield* fs.makeDirectory(path.join(checkout, ".t3"));
    const marker = "1a2b3c4d-1234-4567-8910-1a2b3c4d5e6f\n";
    yield* fs.writeFileString(path.join(checkout, ".t3/setup-done"), marker);
    // Windows setup links no env file here: creating a symlink there needs a privilege.
    const env = path.join(project, ".env");
    const link = path.join(checkout, ".env");
    if (!isWindowsHost) {
      yield* fs.writeFileString(env, "test workspace secret");
      yield* fs.symlink(env, link);
    }
    const admin = yield* git(checkout, "rev-parse", "--absolute-git-dir");
    const head = yield* git(checkout, "rev-parse", "HEAD");
    yield* Effect.tryPromise(async (signal) =>
      writeSetupProof(admin, path.join(admin, "staging-proof"), {
        root: project,
        checkout: setupFileStamp(
          await NodeFSP.lstat(path.join(checkout, ".git"), { bigint: true }),
        ),
        head,
        marker,
        ...(await sealSetupTrees(checkout, ["node_modules"], signal)),
        ...(options.inPlace ? { inPlace: true as const } : {}),
        links: isWindowsHost
          ? []
          : [{ name: ".env", stamp: setupFileStamp(await NodeFSP.lstat(link, { bigint: true })) }],
      }),
    );
    return { fs, path, root, project, checkout, modules, admin, head };
  });

const queueRelease = (fixture: { root: string; checkout: string }, runId = "finished") =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* queueWorktreeRelease({
      stateDir: path.join(fixture.root, "state"),
      threadId: "thread",
      runId,
      worktreePath: fixture.checkout,
      durableRef: "refs/heads/main",
    });
  });

it.live("retains unknown ignored build files without relinking installed dependencies", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const fixture = yield* sealedCheckout();
    const { fs, path, root, project, checkout, modules, admin, head } = fixture;
    const generated = path.join(checkout, "dist");
    yield* fs.makeDirectory(generated, { mode: 0o750 });
    yield* fs.writeFileString(path.join(generated, "bundle.js"), "generated");
    yield* fs.writeFileString(
      path.join(generated, "private.txt"),
      "user data in generated directory",
    );
    const cache = path.join(modules, ".vite-temp");
    yield* fs.makeDirectory(cache);
    yield* fs.writeFileString(path.join(cache, "private.txt"), "user data in dependency cache");
    const release = yield* queueRelease(fixture);
    const request = yield* decodeReleaseRequest(yield* fs.readFileString(release.file));
    expect(release.savedFiles).toBeTruthy();
    // Windows reports allocation too, but a sparse-free fixture cannot pin its value.
    if (!isWindowsHost) expect(request.savedAllocatedBytes).toBeGreaterThan(0);
    const saved = release.savedFiles!;
    expect(yield* fs.readFileString(path.join(saved, "dist/private.txt"))).toBe(
      "user data in generated directory",
    );
    expect(yield* fs.readFileString(path.join(saved, "node_modules/.vite-temp/private.txt"))).toBe(
      "user data in dependency cache",
    );
    expect(yield* fs.exists(path.join(saved, "node_modules/installed.js"))).toBe(false);
    expect(yield* fs.exists(path.join(saved, ".env"))).toBe(false);
    const refs = path.join(admin, "refs");
    yield* fs.makeDirectory(refs, { recursive: true });
    expect(yield* releaseHold(request, project)).toBeNull();
    const lateCache = path.join(modules, ".vite");
    yield* fs.makeDirectory(lateCache);
    expect(yield* releaseHold(request, project)).toBe(
      "ignored files have changed or lack a preserved copy",
    );
    yield* Effect.tryPromise(() => NodeFSP.rmdir(lateCache));
    const lateChange = path.join(cache, "created-after-request.txt");
    yield* fs.writeFileString(lateChange, "new local data");
    expect(yield* releaseHold(request, project)).toBe(
      "ignored files have changed or lack a preserved copy",
    );
    expect(yield* fs.readFileString(lateChange)).toBe("new local data");
    yield* fs.remove(lateChange);
    // Windows keeps its extra data in alternate streams, which the setup scenarios cover.
    if (!isWindowsHost) {
      yield* Effect.tryPromise(() =>
        platform === "darwin"
          ? runFile("/usr/bin/xattr", ["-w", "com.example.codeship", "private data", cache])
          : runFile("python3", [
              "-c",
              "import os, sys; os.setxattr(sys.argv[1], 'user.codeship', b'private data')",
              cache,
            ]),
      );
      expect(yield* releaseHold(request, project)).toBe(
        "ignored files have changed or lack a preserved copy",
      );
      yield* Effect.tryPromise(() =>
        platform === "darwin"
          ? runFile("/usr/bin/xattr", ["-d", "com.example.codeship", cache])
          : runFile("python3", [
              "-c",
              "import os, sys; os.removexattr(sys.argv[1], 'user.codeship')",
              cache,
            ]),
      );
    }
    expect(yield* releaseHold(request, project)).toBeNull();
    const privateRefs = path.join(refs, "worktree");
    yield* fs.makeDirectory(privateRefs);
    yield* fs.writeFileString(path.join(privateRefs, "local-work"), head + "\n");
    expect(yield* releaseHold(request, project)).toBe("worktree has private refs");
    yield* fs.remove(release.file);
    yield* fs.writeFileString(path.join(generated, "second.txt"), "second release contents");
    const second = yield* queueRelease(fixture, "finished-again");
    yield* fs.remove(second.file);
    const state = path.join(root, "state");
    const orphan = path.join(path.dirname(saved), "saved-orphan");
    yield* fs.makeDirectory(orphan);
    const inventory = yield* listWorktreeBackups(state);
    for (const [backup, runId] of [
      [release, "finished"],
      [second, "finished-again"],
    ] as const) {
      expect(inventory.find((entry) => entry.savedFiles === backup.savedFiles)).toMatchObject({
        threadId: "thread",
        runId,
        worktreePath: checkout,
        savedFiles: backup.savedFiles,
        savedAllocatedBytes: backup.savedAllocatedBytes,
      });
    }
    expect(inventory.find((entry) => entry.savedFiles === orphan)).toMatchObject({
      threadId: null,
      runId: null,
      savedAllocatedBytes: null,
    });
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live("holds an original installed file that the owner changed after setup", () =>
  Effect.gen(function* () {
    const fixture = yield* sealedCheckout();
    const { fs, path, project, modules } = fixture;
    yield* fs.writeFileString(path.join(modules, "installed.js"), "edited by the owner");
    const release = yield* queueRelease(fixture);
    const request = yield* decodeReleaseRequest(yield* fs.readFileString(release.file));
    expect(yield* releaseHold(request, project)).toBe(
      "standard setup output changed or could not be verified",
    );
    expect(yield* fs.readFileString(path.join(modules, "installed.js"))).toBe(
      "edited by the owner",
    );
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live("holds a checkout whose dependencies were installed in place", () =>
  Effect.gen(function* () {
    const fixture = yield* sealedCheckout({ inPlace: true });
    const { fs, path, project, modules } = fixture;
    const release = yield* queueRelease(fixture);
    const request = yield* decodeReleaseRequest(yield* fs.readFileString(release.file));
    expect(request.savedSetupExtras).toBeFalsy();
    expect(yield* releaseHold(request, project)).toBe(
      "worktree contains tracked, untracked or ignored local data",
    );
    expect(yield* fs.readFileString(path.join(modules, "installed.js"))).toBe("package contents");
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);
