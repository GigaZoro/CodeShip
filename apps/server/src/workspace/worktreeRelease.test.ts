// @effect-diagnostics nodeBuiltinImport:off -- Native stamps are part of the worktree setup proof.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { linkDirectory } from "@t3tools/shared/testing/symlinks";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import {
  sealSetupMarkers,
  sealSetupTrees,
  setupFileStamp,
  setupProofName,
  writeSetupProof,
} from "../../../../scripts/lib/worktree-setup-proof.ts";
import { layerRealGit } from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  decodeReleaseRequest,
  listWorktreeBackups,
  queueWorktreeRelease,
  recoverInterruptedWorktree,
  releaseHold,
  releasedWorktree,
  worktreeReleaseName,
} from "./worktreeRelease.ts";
import { releaseReservesWorktree } from "./worktreeReleaseReceipt.ts";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
// A held checkout names the metadata check that failed.
const metadataHold =
  /^ignored files have changed or lack a preserved copy \(Ignored directory metadata cannot be preserved: \S.*\)$/;

it.effect("holds a valid case-variant receipt without spreading damage to other paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-receipt-case-" }),
    );
    const original = path.join(root, "Checkout");
    const variant = path.join(root, "checkout");
    // A released checkout is gone, so only a volume that folds case makes two spellings one path.
    const folds = yield* Effect.tryPromise(async () => {
      const [actual, flipped] = await Promise.all([
        NodeFSP.stat(root, { bigint: true }),
        NodeFSP.stat(path.join(path.dirname(root), path.basename(root).toUpperCase()), {
          bigint: true,
        }).catch(() => null),
      ]);
      return flipped !== null && flipped.dev === actual.dev && flipped.ino === actual.ino;
    });
    const owner = ThreadId.make("owner");
    const projectId = ProjectId.make("project");
    const lineage = { parentThreadId: null, relationshipToParent: null, rootThreadId: owner };
    const thread = {
      id: ThreadId.make("stranger"),
      projectId,
      lineage,
      branch: "feature",
      worktreePath: variant,
    };
    const request = {
      threadId: owner,
      runId: "finished",
      branch: thread.branch,
      worktreePath: original,
      identity: "original",
      head: "1".repeat(40),
      durableRef: "refs/heads/main",
      family: [{ threadId: owner, projectId, lineage, runId: "finished" }],
    };
    const marker = (name: string) => path.join(root, worktreeReleaseName(name) + ".released");
    yield* fs.writeFileString(marker(path.join(root, "other")), "unreadable historical receipt");
    yield* fs.writeFileString(marker(path.join(root, "wrong-digest")), JSON.stringify(request));
    const lookup = (checkoutExists: boolean, system = fs) =>
      releasedWorktree(
        system,
        root,
        variant,
        thread,
        () => Effect.die("folded lookup must not consult lineage"),
        checkoutExists,
        () => Effect.die("folded lookup must not authorize a replacement"),
      );
    expect(yield* releaseReservesWorktree(fs, root, variant)).toBe(false);
    expect(yield* lookup(false)).toBeNull();

    let published = false;
    const publishing = {
      ...fs,
      readDirectory: Effect.fnUntraced(function* (directory: string) {
        const names = yield* fs.readDirectory(directory);
        if (!published) {
          published = true;
          yield* fs.writeFileString(marker(original), JSON.stringify(request));
        }
        return names;
      }),
    };
    expect(yield* Effect.flip(releaseReservesWorktree(publishing, root, variant))).toMatchObject({
      _tag: "WorktreeReleaseReceiptError",
    });

    const repaired = path.join(root, "Repaired");
    const repairMarker = marker(repaired);
    yield* fs.writeFileString(repairMarker, "damaged");
    let reads = 0;
    const repairing = {
      ...fs,
      readDirectory: Effect.fnUntraced(function* (directory: string) {
        if (++reads === 2)
          yield* fs.writeFileString(
            repairMarker,
            JSON.stringify({ ...request, worktreePath: repaired }),
          );
        return yield* fs.readDirectory(directory);
      }),
    };
    const repairedVariant = path.join(root, "repaired");
    expect(
      yield* Effect.flip(releaseReservesWorktree(repairing, root, repairedVariant)),
    ).toMatchObject({
      _tag: "WorktreeReleaseReceiptError",
      receipt: repairMarker,
    });
    expect(yield* releaseReservesWorktree(fs, root, repairedVariant)).toBe(folds);

    const started = yield* Deferred.make<void>();
    let waiting = 0;
    const slow = {
      ...fs,
      readDirectory: Effect.fnUntraced(function* () {
        if (++waiting === 2) yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    };
    const timed = yield* Effect.all(
      [
        Effect.result(releaseReservesWorktree(slow, root, variant)),
        Effect.result(lookup(false, slow)),
      ],
      { concurrency: 2 },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* TestClock.adjust("6 seconds");
    expect(yield* Fiber.join(timed)).toMatchObject([
      { _tag: "Failure", failure: { _tag: "WorktreeReleaseReceiptError" } },
      { _tag: "Failure", failure: { _tag: "WorktreeReleaseReceiptError" } },
    ]);

    expect(yield* releaseReservesWorktree(fs, root, variant)).toBe(folds);
    if (folds)
      expect(yield* Effect.flip(lookup(false))).toMatchObject({
        _tag: "GitCommandError",
        detail: expect.stringContaining(marker(original)),
      });
    else expect(yield* lookup(false)).toBeNull();
    const unrelated = path.join(root, "unrelated");
    expect(yield* releaseReservesWorktree(fs, root, unrelated)).toBe(false);
    yield* fs.makeDirectory(variant);
    const aliasesExisting = yield* fs.exists(original);
    if (!aliasesExisting) yield* fs.makeDirectory(original);
    expect(yield* releaseReservesWorktree(fs, root, variant)).toBe(aliasesExisting);
    const result = yield* Effect.result(lookup(true));
    if (aliasesExisting) expect(result._tag).toBe("Failure");
    else expect(result).toMatchObject({ _tag: "Success", success: null });
    expect(yield* fs.readFileString(marker(original))).toBe(JSON.stringify(request));
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live(
  "holds the highest-priority damaged release marker and accepts a valid one-MiB receipt",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-terminal-receipt-" }),
      );
      const checkout = path.join(root, "checkout");
      const owner = ThreadId.make("owner");
      const thread = {
        id: owner,
        branch: "feature",
        projectId: ProjectId.make("project"),
        worktreePath: checkout,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: owner },
      };
      const lookup = releasedWorktree(
        fs,
        root,
        checkout,
        thread,
        () => Effect.die("unexpected lineage lookup"),
        false,
        () => Effect.die("unexpected replacement"),
      );
      const request = {
        threadId: owner,
        branch: thread.branch,
        worktreePath: checkout,
        runId: "finished",
        identity: "original",
        head: "1".repeat(40),
        durableRef: "refs/heads/main",
      };
      const json = JSON.stringify(request);
      const contents = json + " ".repeat(1024 * 1024 - Buffer.byteLength(json));
      const file = path.join(root, worktreeReleaseName(checkout));
      const setup = file + ".setup";
      const marker = file + ".restoring";
      yield* fs.writeFileString(setup, contents);
      const hold = { _tag: "WorktreeReleaseReceiptError", receipt: marker };
      for (const invalid of [
        contents + " ",
        JSON.stringify({ ...request, worktreePath: path.join(root, "other") }),
        JSON.stringify({ ...request, unknownReleaseFormat: true }),
      ]) {
        yield* fs.writeFileString(marker, invalid);
        expect(yield* Effect.flip(lookup)).toMatchObject(hold);
        expect(yield* fs.readFileString(marker)).toBe(invalid);
      }
      yield* fs.remove(marker);
      const target = path.join(root, "target");
      yield* fs.makeDirectory(target);
      yield* linkDirectory(target, marker);
      yield* fs.remove(target, { recursive: true });
      expect(yield* Effect.flip(lookup)).toMatchObject(hold);
      expect((yield* Effect.promise(() => NodeFSP.lstat(marker))).isSymbolicLink()).toBe(true);
      yield* fs.remove(marker);
      yield* fs.writeFileString(
        path.join(root, worktreeReleaseName(path.join(root, "other"))) + ".restoring",
        "bad receipt for another checkout",
      );
      const accepted = yield* lookup;
      expect(accepted?.receipt).toBe(setup);
      expect(accepted?.request).toEqual(request);
      expect(accepted?.contents).toBe(contents);
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

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
        markerMetadataV1: await sealSetupMarkers(checkout, "setup-done", signal),
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

it.live("holds a newly set pull request base after an absent base was queued", () =>
  Effect.gen(function* () {
    const fixture = yield* sealedCheckout();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const release = yield* queueRelease(fixture);
    const request = yield* decodeReleaseRequest(yield* fixture.fs.readFileString(release.file));
    yield* driver.execute({
      operation: "test.setBase",
      cwd: fixture.project,
      args: ["config", "--local", "branch.feature.t3-merge-base", "main"],
    });
    expect(yield* releaseHold(request, fixture.project)).toBe(
      "the recorded pull request base changed",
    );
    const { branchBase: _branchBase, ...unrecorded } = request;
    expect(yield* releaseHold(unrecorded, fixture.project)).toBe(
      "the release receipt predates base recording; queue the release again",
    );
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live.each(["refs/heads/main", "refs/remotes/origin/main"] as const)(
  "queues an explicit local or remote base ref: %s",
  (ref) =>
    Effect.gen(function* () {
      const fixture = yield* sealedCheckout();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.execute({
        operation: "test.setBase",
        cwd: fixture.project,
        args: ["config", "--local", "branch.feature.t3-merge-base-ref", ref],
      });
      const release = yield* queueRelease(fixture);
      const request = yield* decodeReleaseRequest(yield* fixture.fs.readFileString(release.file));
      expect(request.branchBase?.ref).toBe(ref);
      expect(yield* releaseHold(request, fixture.project)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live.each([
  { name: "invalid base name", property: "t3-merge-base", value: "bad..name" },
  { name: "invalid legacy name", property: "gh-merge-base", value: "bad..legacy" },
  { name: "wrong ref prefix", property: "t3-merge-base-ref", value: "refs/tags/main" },
  { name: "invalid local ref", property: "t3-merge-base-ref", value: "refs/heads/bad..name" },
] as const)("names invalid branch configuration: $name", ({ property, value }) =>
  Effect.gen(function* () {
    const fixture = yield* sealedCheckout();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const key = `branch.feature.${property}`;
    yield* driver.execute({
      operation: "test.invalidBase",
      cwd: fixture.project,
      args: ["config", "--local", key, value],
    });
    const error = yield* Effect.flip(queueRelease(fixture));
    expect(error).toMatchObject({ _tag: "GitCommandError", detail: expect.stringContaining(key) });
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live.each(["empty", "multiple"] as const)("rejects %s branch base configuration", (mode) =>
  Effect.gen(function* () {
    const fixture = yield* sealedCheckout();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const command = (value: string) =>
      driver.execute({
        operation: "test.setBase",
        cwd: fixture.project,
        args: ["config", "--local", "--add", "branch.feature.t3-merge-base", value],
      });
    yield* command(mode === "empty" ? "" : "main");
    if (mode === "multiple") yield* command("other");
    const error = yield* Effect.flip(queueRelease(fixture));
    expect(error).toMatchObject({
      _tag: "GitCommandError",
      detail: expect.stringContaining("exactly one nonempty value"),
    });
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live.each(["saved cache", "installed dependency", "setup proof"] as const)(
  "keeps an interrupted removal claimed after losing its %s",
  (lost) =>
    Effect.gen(function* () {
      const fixture = yield* sealedCheckout();
      const { fs, path, project, checkout, admin, modules } = fixture;
      const cache = path.join(modules, ".vite-temp");
      if (lost === "saved cache") {
        yield* fs.makeDirectory(cache);
        yield* fs.writeFileString(path.join(cache, "private.txt"), "local build contents");
      }
      const { file } = yield* queueRelease(fixture);
      const request = yield* decodeReleaseRequest(yield* fs.readFileString(file));
      yield* fs.rename(file, file + ".releasing");
      const verify = recoverInterruptedWorktree(checkout, project, "feature", {
        original: { ...request, backupDirectory: path.dirname(file) },
      });
      yield* verify;
      if (lost === "saved cache") yield* fs.remove(cache, { recursive: true });
      else if (lost === "installed dependency")
        yield* fs.remove(path.join(modules, "installed.js"));
      else yield* fs.remove(path.join(admin, setupProofName));
      expect(yield* Effect.isFailure(verify)).toBe(true);
      expect(yield* fs.exists(file + ".releasing")).toBe(true);
      if (request.savedFiles) {
        expect(
          yield* fs.readFileString(
            path.join(request.savedFiles, "node_modules/.vite-temp/private.txt"),
          ),
        ).toBe("local build contents");
      }
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.live("retains unknown ignored build files without relinking installed dependencies", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const fixture = yield* sealedCheckout();
    const { fs, path, root, project, checkout, modules, admin, head } = fixture;
    const generated = path.join(checkout, "dist");
    yield* fs.makeDirectory(generated, { mode: 0o750 });
    // Two entries make APFS report a three-digit directory size, padding ls's provenance column.
    yield* fs.writeFileString(path.join(generated, "bundle.js"), "generated");
    yield* fs.writeFileString(
      path.join(generated, "private.txt"),
      "user data in generated directory",
    );
    const cache = path.join(modules, ".vite-temp");
    yield* fs.makeDirectory(cache);
    yield* fs.writeFileString(path.join(cache, "private.txt"), "user data in dependency cache");
    const astro = path.join(modules, ".astro");
    yield* fs.makeDirectory(astro);
    yield* fs.writeFileString(path.join(astro, "data-store.json"), "generated Astro data");
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
    expect(yield* fs.readFileString(path.join(saved, "node_modules/.astro/data-store.json"))).toBe(
      "generated Astro data",
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
      expect(yield* releaseHold(request, project)).toMatch(metadataHold);
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
    if (platform === "darwin") {
      const savedCache = path.join(saved, "node_modules/.vite-temp");
      const { stdout: attributes } = yield* Effect.tryPromise(() =>
        runFile("/usr/bin/xattr", [cache]),
      );
      if (attributes.split("\n").includes("com.apple.provenance")) {
        const stamp = (directory: string) =>
          runFile("/usr/bin/xattr", ["-px", "com.apple.provenance", directory]);
        const [sourceStamp, savedStamp] = yield* Effect.tryPromise(() =>
          Promise.all([stamp(cache), stamp(savedCache)]),
        );
        expect(savedStamp.stdout).toBe(sourceStamp.stdout);
      }
      const acl = "everyone allow readattr";
      // Select Apple's chmod even when the package runner supplies a portable binary.
      const changeAcl = (operation: string) =>
        runFile("/usr/bin/python3", [
          "-I",
          "-c",
          "import os, sys; os.execv('/bin/chmod', ['chmod', *sys.argv[1:]])",
          operation,
          acl,
          savedCache,
        ]);
      yield* Effect.tryPromise(() => changeAcl("+a"));
      expect(yield* releaseHold(request, project)).toMatch(metadataHold);
      yield* Effect.tryPromise(() => changeAcl("-a"));
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
