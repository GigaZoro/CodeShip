// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createPackageWithOptions, extractFile } from "@electron/asar";
import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { fromYaml } from "@t3tools/shared/schemaYaml";

import {
  buildDesktopBundles,
  copyDesktopBuildArtifacts,
  DesktopBuildManifestRestoreError,
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  parseWslRuntimeArchiveMembers,
  readWorkspaceConfig,
  createBuildConfig,
  DESKTOP_FILE_EXCLUSIONS,
  ELECTRON_DIST_DIR,
  ElectronDistStageError,
  findStageLockfileDrift,
  installStagedDependencies,
  readPnpmLockfileGraph,
  StageLockfileDriftError,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  UnsupportedDesktopBuildArchitectureError,
  UnsupportedDesktopBuildTargetError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  preflightWindowsDesktopBuild,
  renderMacPasskeyEntitlements,
  resolveMacWebAuthnEntitlements,
  resolveMacPasskeySigningConfiguration,
  resolveMergedStageDependencies,
  resolveBuildOptions,
  stageWslRuntimeArchive,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  LinuxBrowserSecretHostError,
  MacPackagedAppMissingError,
  stageBrowserSecret,
  validateMacPackagedPayload,
  validateWindowsPackagedPayload,
  verifyPackagedBundleIsSelfContained,
  WindowsPrimaryNativeProbeError,
  WindowsDesktopBuildPrerequisitesMissingError,
  WindowsPackagedPayloadValidationError,
  stageCursorSdkPlatformPackages,
  stageElectronDist,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
  wslRuntimeArchiveStem,
  writeStageWorkspace,
} from "./build-desktop-artifact.ts";
import {
  ReleasePackageManifestError,
  releasePackageFiles,
} from "./update-release-package-versions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

const desktopElectronVersion = desktopPackageJson.dependencies.electron;

const encodeModuleUrl = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodePackageVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

// pnpm writes its own install as a leading document in both lockfiles.
const PNPM_LOCKFILE_DOCUMENT = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.14.0
        version: 12.14.0

packages:

  pnpm@12.14.0:
    resolution: {integrity: sha512-pnpm}

snapshots:

  pnpm@12.14.0: {}
`;

// Shaped like the repo lockfile: electron-webauthn carries a typescript peer that
// STAGE_PEER_OVERRIDES removes in a stage, and fff-node reaches its platform binary.
const ROOT_LOCKFILE_FIXTURE = `${PNPM_LOCKFILE_DOCUMENT}
---
lockfileVersion: '9.0'

patchedDependencies:
  node-pty@1.2.0-beta.15: a111

importers:

  apps/desktop:
    dependencies:
      '@t3tools/shared':
        specifier: workspace:*
        version: link:../../packages/shared
      electron-webauthn:
        specifier: 1.3.1
        version: 1.3.1(@tsc-rs/typescript@0.8.0)
      node-pty:
        specifier: 1.2.0-beta.15
        version: 1.2.0-beta.15(patch_hash=a111)
      zod:
        specifier: 4.6.5
        version: 4.6.5

  apps/server:
    dependencies:
      '@ff-labs/fff-node':
        specifier: 0.11.0
        version: 0.11.0

packages:

  '@ff-labs/fff-bin-darwin-arm64@0.11.0':
    resolution: {integrity: sha512-fff-bin}

  '@ff-labs/fff-node@0.11.0':
    resolution: {integrity: sha512-fff-node}

  '@tsc-rs/typescript@0.8.0':
    resolution: {integrity: sha512-tsc-rs}

  electron-webauthn@1.3.1:
    resolution: {integrity: sha512-webauthn}

  node-pty@1.2.0-beta.15:
    resolution: {integrity: sha512-pty}

  typescript@6.0.3:
    resolution: {integrity: sha512-typescript}

  zod@4.6.4:
    resolution: {integrity: sha512-zod-4.6.4}

  zod@4.6.5:
    resolution: {integrity: sha512-zod}

snapshots:

  '@ff-labs/fff-bin-darwin-arm64@0.11.0': {}

  '@ff-labs/fff-node@0.11.0':
    optionalDependencies:
      '@ff-labs/fff-bin-darwin-arm64': 0.11.0

  '@tsc-rs/typescript@0.8.0': {}

  electron-webauthn@1.3.1(@tsc-rs/typescript@0.8.0):
    dependencies:
      typescript: '@tsc-rs/typescript@0.8.0'
      zod: 4.6.5

  electron-webauthn@1.3.1(zod@4.6.4):
    dependencies:
      zod: 4.6.4

  node-pty@1.2.0-beta.15(patch_hash=a111): {}

  typescript@6.0.3: {}

  zod@4.6.4: {}

  zod@4.6.5: {}
`;

const stageLockfileFixture = (input: {
  readonly zod?: string;
  readonly zodIntegrity?: string;
  readonly webauthnSnapshot?: string;
  /** `null` installs node-pty without its patch. */
  readonly patchHash?: string | null;
  readonly extraDirectDependency?: string;
}) => {
  const zod = input.zod ?? "4.6.5";
  const patchHash = input.patchHash === undefined ? "a111" : input.patchHash;
  const nodePty = patchHash === null ? "1.2.0-beta.15" : `1.2.0-beta.15(patch_hash=${patchHash})`;
  return `${PNPM_LOCKFILE_DOCUMENT}
---
lockfileVersion: '9.0'
${
  patchHash === null
    ? ""
    : `
patchedDependencies:
  node-pty@1.2.0-beta.15: ${patchHash}
`
}
importers:

  .:
    dependencies:
      '@ff-labs/fff-bin-darwin-arm64':
        specifier: 0.11.0
        version: 0.11.0
      electron-webauthn:
        specifier: 1.3.1
        version: 1.3.1
      node-pty:
        specifier: 1.2.0-beta.15
        version: ${nodePty}${
          input.extraDirectDependency === undefined
            ? ""
            : `
      ${input.extraDirectDependency}`
        }

packages:

  '@ff-labs/fff-bin-darwin-arm64@0.11.0':
    resolution: {integrity: sha512-fff-bin}

  electron-webauthn@1.3.1:
    resolution: {integrity: sha512-webauthn}

  node-pty@1.2.0-beta.15:
    resolution: {integrity: sha512-pty}

  zod@${zod}:
    resolution: {integrity: ${input.zodIntegrity ?? "sha512-zod"}}

snapshots:

  '@ff-labs/fff-bin-darwin-arm64@0.11.0': {}

  ${
    input.webauthnSnapshot ??
    `electron-webauthn@1.3.1:
    dependencies:
      zod: ${zod}`
  }

  node-pty@${nodePty}: {}

  zod@${zod}: {}
`;
};

const STAGE_SOURCE_IMPORTERS = ["apps/desktop", "apps/server"];

// Signing, notarization and registry credentials, in each spelling pnpm and npm read.
const CREDENTIAL_NAMES = [
  "AZURE_CLIENT_SECRET",
  "NODE_AUTH_TOKEN",
  "pnpm_config__auth",
  "PNPM_CONFIG__AUTH",
  "npm_config_//registry.npmjs.org/:_authToken",
];

const makeLinuxCliArchiveFixture = Effect.fn("test.makeLinuxCliArchiveFixture")(function* (input: {
  readonly root: string;
  readonly stem: string;
  readonly extraMembers?: ReadonlyArray<string>;
  readonly omitMembers?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const contentRoot = path.join(input.root, "content");
  const members = [
    `${input.stem}/t3`,
    `${input.stem}/client/index.html`,
    `${input.stem}/node_modules/node-pty/package.json`,
    `${input.stem}/node_modules/node-pty/build/Release/pty.node`,
    ...(input.extraMembers ?? []),
  ].filter((member) => !(input.omitMembers ?? []).includes(member));
  for (const member of members) {
    const memberPath = path.join(contentRoot, member);
    yield* fs.makeDirectory(path.dirname(memberPath), { recursive: true });
    yield* fs.writeFileString(memberPath, member);
  }
  const archiveName = `${input.stem}.tar.gz`;
  const tar = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", archiveName, "-C", path.basename(contentRoot), "."], {
      cwd: input.root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  assert.equal(Number(yield* tar.exitCode), 0);
  return path.join(input.root, archiveName);
});

function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const WINDOWS_PAYLOAD_FIXTURE_VERSION = "1.2.3";

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly wslRuntime?: "valid" | "loose-server-tree" | "missing-pty" | "bad-digest";
  readonly targetArch?: "x64" | "arm64";
  readonly ptyPrebuildArch?: "x64" | "arm64";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "MZ native-binary");

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  if (input.wslRuntime !== undefined) {
    const stem = wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, input.targetArch ?? "x64");
    const sourceArchivePath =
      input.wslRuntime === "loose-server-tree"
        ? yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem: "apps",
            omitMembers: ["apps/t3", "apps/client/index.html"],
            extraMembers: ["apps/server/dist/bin.mjs", "node_modules/node-pty/package.json"],
          })
        : yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem,
            ...(input.wslRuntime === "missing-pty" || input.ptyPrebuildArch !== undefined
              ? { omitMembers: [`${stem}/node_modules/node-pty/build/Release/pty.node`] }
              : {}),
            ...(input.ptyPrebuildArch !== undefined
              ? {
                  extraMembers: [
                    `${stem}/node_modules/node-pty/prebuilds/linux-${input.ptyPrebuildArch}/pty.node`,
                  ],
                }
              : {}),
          });
    const archivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
    const hashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
    yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });
    if (input.wslRuntime === "bad-digest") {
      yield* fs.writeFileString(hashPath, `${"0".repeat(64)}\n`);
    }
  }

  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});

const makeMacPayloadFixture = Effect.fn("test.makeMacPayloadFixture")(function* (input: {
  readonly serverEntrySource?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mac-payload-test-" });
  const sourceDir = path.join(tempDir, "app-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");

  const stageDistDir = path.join(tempDir, "dist");
  const resourcesDir = path.join(stageDistDir, "mac-arm64/T3.CodeShip.app/Contents/Resources");
  yield* fs.makeDirectory(resourcesDir, { recursive: true });
  yield* Effect.promise(() =>
    createPackageWithOptions(sourceDir, path.join(resourcesDir, "app.asar"), {}),
  );
  return { stageDistDir } as const;
});

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it.effect("rejects overlapping builds from another process until restoration finishes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-concurrent-build-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        '{ "scripts": { "build:desktop": "node build.cjs" } }',
      );
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      yield* fs.writeFileString(
        path.join(root, "build.cjs"),
        `require("node:fs").writeFileSync("version.txt", require("./apps/server/package.json").version);`,
      );
      const restoring = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const contenderPath = path.join(root, "contender.mjs");
      yield* fs.writeFileString(
        contenderPath,
        `import * as Effect from ${yield* encodeModuleUrl(import.meta.resolve("effect/Effect"))};
           import * as NodeServices from ${yield* encodeModuleUrl(import.meta.resolve("@effect/platform-node/NodeServices"))};
           import { buildDesktopBundles } from ${yield* encodeModuleUrl(import.meta.resolve("./build-desktop-artifact.ts"))};
           const result = await Effect.runPromise(buildDesktopBundles(process.argv[2], "0.0.44", false).pipe(
             Effect.as("success"), Effect.catch(error => Effect.succeed(error._tag)),
             Effect.scoped, Effect.provide(NodeServices.layer)));
           process.stdout.write(result);`,
      );
      const first = yield* Effect.forkChild(
        Effect.exit(buildDesktopBundles(root, "0.0.43", false)).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (filePath, contents, options) =>
              filePath === path.join(root, releasePackageFiles[0]) && contents === original
                ? Deferred.succeed(restoring, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(fs.writeFileString(filePath, contents, options)),
                  )
                : fs.writeFileString(filePath, contents, options),
          }),
        ),
      );
      yield* Deferred.await(restoring);
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [contenderPath, root]),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(Number(exitCode), 0, stderr);
        assert.equal(stdout, "DesktopBuildAlreadyRunningError");
      }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
      const firstExit = yield* Fiber.join(first);
      assert.isTrue(Exit.isSuccess(firstExit));
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.43");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false);
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.44");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it.effect("restores manifests and releases the checkout lock after interruption", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-interrupted-build-" });
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const started = yield* Deferred.make<void>();
      const childStopped = yield* Deferred.make<{ lockExists: boolean; version: string }>();
      const build = yield* Effect.forkChild(
        buildDesktopBundles(root, "0.0.43", false).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.acquireRelease(
                Effect.succeed({ ...mockProcess(0), exitCode: Effect.never }).pipe(
                  Effect.tap(() => Deferred.succeed(started, undefined)),
                ),
                () =>
                  Effect.gen(function* () {
                    const lockExists = yield* fs.exists(path.join(root, ".desktop-build.lock"));
                    const manifest = yield* decodePackageVersion(
                      yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
                    );
                    yield* Deferred.succeed(childStopped, {
                      lockExists,
                      version: manifest.version,
                    });
                  }).pipe(Effect.orDie),
              ),
            ),
          ),
          Effect.scoped,
        ),
      );
      yield* Deferred.await(started);
      const aligned = yield* decodePackageVersion(
        yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
      );
      assert.equal(aligned.version, "0.0.43");
      yield* Fiber.interrupt(build);
      assert.deepEqual(yield* Deferred.await(childStopped), {
        lockExists: true,
        version: "0.0.43",
      });
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
        ),
      );
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
    }),
  );

  it.effect(
    "builds web, server and desktop with the resolved version, restores changed manifests and preserves edits to matching ones",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-build-version-" });
        const packageJson = `{
          "name": "desktop-version-fixture",
          "version": "0.0.42",
          "scripts": { "build:desktop": "node build.cjs" }
        }`;
        yield* fs.writeFileString(path.join(root, "package.json"), packageJson);
        const version = "0.0.43-nightly.20260920.2018";
        const matchingPath = "packages/contracts/package.json";
        const originals = releasePackageFiles.map((relativePath, index) => ({
          relativePath,
          contents: `{ "version": "${relativePath === matchingPath ? version : `0.0.${index + 1}`}", "name": "${relativePath}" }\r\n`,
        }));
        const afterBuild = originals.map(({ relativePath, contents }) => ({
          relativePath,
          contents:
            relativePath === matchingPath
              ? `${JSON.stringify({ version, name: matchingPath, description: "edited during compilation" })}\n`
              : contents,
        }));
        for (const { relativePath, contents } of originals) {
          const filePath = path.join(root, relativePath);
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, contents);
        }
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          `require("node:fs").writeFileSync("version.txt", [
            process.env.APP_VERSION,
            require("./apps/web/package.json").version,
            require("./apps/server/package.json").version,
            require("./apps/desktop/package.json").version
          ].join("\\n"));
          const manifest = require("./${matchingPath}");
          manifest.description = "edited during compilation";
          require("node:fs").writeFileSync("${matchingPath}", JSON.stringify(manifest) + "\\n");`,
        );
        yield* buildDesktopBundles(root, version, false);
        assert.equal(
          yield* fs.readFileString(path.join(root, "version.txt")),
          [version, version, version, version].join("\n"),
        );
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
        yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(1);");
        const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(failure, BuildCommandFailedError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        const invalidPath = releasePackageFiles[releasePackageFiles.length - 1]!;
        yield* fs.writeFileString(path.join(root, invalidPath), "invalid manifest");
        // A successful child would leave a marker if partial alignment accidentally starts it.
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          'require("node:fs").writeFileSync("unexpected-build.txt", "started");',
        );
        const alignmentFailure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(alignmentFailure, ReleasePackageManifestError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(
            yield* fs.readFileString(path.join(root, relativePath)),
            relativePath === invalidPath ? "invalid manifest" : contents,
          );
        }
        assert.isFalse(yield* fs.exists(path.join(root, "unexpected-build.txt")));
        assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
      }),
  );

  it.effect("reports a restore failure while still restoring the remaining manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-manifest-restore-failure-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        `{
          "name": "restore-fixture", "scripts": { "build:desktop": "node build.cjs" }
        }`,
      );
      yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(0);");
      const original = '{ "version": "0.0.42" }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const failedPath = path.join(root, releasePackageFiles[0]);
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "writeFileString",
        pathOrDescriptor: failedPath,
      });
      const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.43", false)).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (filePath, contents, options) =>
            filePath === failedPath && contents === original
              ? Effect.fail(writeFailure)
              : fs.writeFileString(filePath, contents, options),
        }),
      );
      assert.instanceOf(failure, DesktopBuildManifestRestoreError);
      assert.notEqual(yield* fs.readFileString(failedPath), original);
      for (const relativePath of releasePackageFiles.slice(1)) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it.effect("omits update feeds for pull request preview builds", () =>
    Effect.gen(function* () {
      const preview = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33-pr.8182.1",
        false,
        false,
        undefined,
        undefined,
      );
      const release = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
      );

      const previewChannel = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.41-preview.20260912.1589",
        false,
        false,
        undefined,
        undefined,
      );

      assert.isNull(preview.publish);
      assert.isNull(previewChannel.publish);
      assert.deepStrictEqual(release.publish, [
        {
          provider: "github",
          owner: "pingdotgg",
          repo: "t3code",
          releaseType: "release",
        },
      ]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
        ),
      ),
    ),
  );

  // pnpm writes "set this to true or false" placeholders into allowBuilds when a
  // tarball changes. pnpm ignores them, but the release build decode rejects them.
  it.effect("decodes the repo allowBuilds and every file: tarball it names exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { allowBuilds = {} } = yield* readWorkspaceConfig();
      const repoRoot = path.join(import.meta.dirname, "..");
      for (const key of Object.keys(allowBuilds)) {
        const tarball = key.split("@file:")[1]?.replace(/\(patch_hash=[a-f0-9]+\)$/, "");
        if (tarball === undefined) continue;
        assert.isTrue(
          yield* fs.exists(path.join(repoRoot, tarball)),
          `allowBuilds names a missing tarball: ${key}`,
        );
      }
    }),
  );

  it.effect.each([
    { name: "a stage that reuses the root resolutions", stage: {}, drift: [] },
    {
      name: "a version the root lockfile lacks",
      stage: { zod: "4.6.7" },
      drift: [
        "zod@4.6.7 is not in pnpm-lock.yaml",
        "electron-webauthn@1.3.1 depends on zod@4.6.7, which pnpm-lock.yaml does not",
      ],
    },
    {
      name: "a root version fetched from another tarball",
      stage: { zodIntegrity: "sha512-other" },
      drift: ["zod@4.6.5 resolves to a different tarball than pnpm-lock.yaml"],
    },
    {
      name: "a peer the root lockfile never links for that package",
      stage: {
        webauthnSnapshot: `electron-webauthn@1.3.1(typescript@6.0.3):
    dependencies:
      typescript: 6.0.3
      zod: 4.6.5`,
      },
      drift: [
        "electron-webauthn@1.3.1(typescript@6.0.3) is a peer or patch variant pnpm-lock.yaml does not have",
      ],
    },
    {
      name: "a peer variant with another variant's dependency",
      stage: {
        webauthnSnapshot: `electron-webauthn@1.3.1(zod@4.6.4):
    dependencies:
      zod: 4.6.5`,
      },
      drift: [
        "electron-webauthn@1.3.1(zod@4.6.4) depends on zod@4.6.5, which pnpm-lock.yaml does not",
      ],
    },
    {
      name: "a dependency the root lockfile records and the stage drops",
      stage: { webauthnSnapshot: "electron-webauthn@1.3.1: {}" },
      drift: ["electron-webauthn@1.3.1 lacks its dependency zod@4.6.5 from pnpm-lock.yaml"],
    },
    {
      name: "a dependency the stage makes optional",
      stage: {
        webauthnSnapshot: `electron-webauthn@1.3.1:
    optionalDependencies:
      zod: 4.6.5`,
      },
      drift: [
        "electron-webauthn@1.3.1 lacks its dependency zod@4.6.5 from pnpm-lock.yaml",
        "electron-webauthn@1.3.1 depends on zod@4.6.5 (optional), which pnpm-lock.yaml does not",
      ],
    },
    {
      name: "a patch that differs from the root lockfile",
      stage: { patchHash: "b222" },
      drift: [
        "node-pty resolved to 1.2.0-beta.15(patch_hash=b222), but pnpm-lock.yaml pins 1.2.0-beta.15(patch_hash=a111)",
        "node-pty@1.2.0-beta.15(patch_hash=b222) is a peer or patch variant pnpm-lock.yaml does not have",
        "the patch for node-pty@1.2.0-beta.15 differs from pnpm-lock.yaml",
      ],
    },
    {
      name: "a patched package installed without its patch",
      stage: { patchHash: null },
      drift: [
        "node-pty resolved to 1.2.0-beta.15, but pnpm-lock.yaml pins 1.2.0-beta.15(patch_hash=a111)",
        "node-pty@1.2.0-beta.15 is a peer or patch variant pnpm-lock.yaml does not have",
      ],
    },
    {
      name: "a direct dependency no source importer has",
      stage: {
        extraDirectDependency: `typescript:
        specifier: 6.0.3
        version: 6.0.3`,
      },
      drift: ["typescript is not a dependency of apps/desktop or apps/server in pnpm-lock.yaml"],
    },
    {
      name: "a workspace link",
      stage: {
        extraDirectDependency: `'@t3tools/shared':
        specifier: workspace:*
        version: link:../../packages/shared`,
      },
      drift: ["@t3tools/shared installs from a local path (link:../../packages/shared)"],
    },
  ])("reports staged lockfile drift for $name", ({ stage, drift }) =>
    Effect.gen(function* () {
      const root = yield* readPnpmLockfileGraph(ROOT_LOCKFILE_FIXTURE);
      const staged = yield* readPnpmLockfileGraph(stageLockfileFixture(stage));

      assert.deepStrictEqual(findStageLockfileDrift(root, staged, STAGE_SOURCE_IMPORTERS), drift);
    }),
  );

  it.effect("gives a stage the root's patches, overrides and package extensions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-workspace-" });
        const stageDir = path.join(repoRoot, "stage");
        yield* fs.makeDirectory(path.join(repoRoot, "patches"));
        yield* fs.makeDirectory(stageDir);
        yield* fs.writeFileString(path.join(repoRoot, "patches", "node-pty.patch"), "patch\n");

        yield* writeStageWorkspace({
          repoRoot,
          stageDir,
          platform: "mac",
          arch: "arm64",
          workspace: {
            catalog: { "vite-plus": "1.4.0", zod: "4.6.5" },
            overrides: { zod: "catalog:" },
            packageExtensions: {
              "@effect/vitest@*": { dependencies: { "vite-plus": "catalog:" } },
              "plugin-host@*": {
                peerDependencies: { zod: "catalog:" },
                peerDependenciesMeta: { zod: { optional: true } },
              },
            },
            patchedDependencies: { "node-pty@1.2.0-beta.15": "patches/node-pty.patch" },
            allowBuilds: { "node-pty": true },
          },
          nodeLinker: "hoisted",
        });

        assert.deepStrictEqual(
          yield* Schema.decodeEffect(fromYaml(Schema.Unknown))(
            yield* fs.readFileString(path.join(stageDir, "pnpm-workspace.yaml")),
          ),
          {
            supportedArchitectures: { os: ["darwin"], cpu: ["arm64"] },
            allowBuilds: { "node-pty": true },
            patchedDependencies: { "node-pty@1.2.0-beta.15": "patches/node-pty.patch" },
            allowUnusedPatches: true,
            overrides: {
              zod: "4.6.5",
              "electron-webauthn>typescript": "-",
              "@electron-webauthn/macos>typescript": "-",
            },
            packageExtensions: {
              "@effect/vitest@*": { dependencies: { "vite-plus": "1.4.0" } },
              "plugin-host@*": {
                peerDependencies: { zod: "4.6.5" },
                peerDependenciesMeta: { zod: { optional: true } },
              },
            },
            nodeLinker: "hoisted",
          },
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(stageDir, "patches", "node-pty.patch")),
          "patch\n",
        );
      }),
    ),
  );

  it.effect("decodes the repo lockfile in the shape the drift check reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockfile = yield* fs.readFileString(
        path.join(import.meta.dirname, "..", "pnpm-lock.yaml"),
      );
      const graph = yield* readPnpmLockfileGraph(lockfile);

      assert.isTrue(graph.resolutions.has(`electron@${desktopElectronVersion}`));
      assert.isTrue(
        graph.importers.get("apps/desktop")?.["electron"]?.startsWith(desktopElectronVersion),
      );
      assert.isTrue(graph.patchHashes.size > 0);
      assert.isTrue([...graph.snapshots.keys()].some((key) => key.includes("(patch_hash=")));
    }),
  );

  it.effect.each([
    {
      name: "installs a stage that keeps the root resolutions",
      resolved: stageLockfileFixture({}),
      drift: undefined,
      commands: [
        "install --lockfile-only --no-frozen-lockfile --ignore-scripts",
        "install --frozen-lockfile --prod",
      ],
    },
    {
      name: "fails a drifting stage before anything is installed",
      // A newer zod release stands in for a fresh resolution.
      resolved: stageLockfileFixture({ zod: "4.6.7" }),
      drift: "zod@4.6.7 is not in pnpm-lock.yaml",
      commands: ["install --lockfile-only --no-frozen-lockfile --ignore-scripts"],
    },
  ])("$name", ({ resolved, drift, commands }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            for (const name of CREDENTIAL_NAMES) vi.stubEnv(name, "fixture-credential");
            vi.stubEnv("pnpm_config_store_dir", "/fixture/store");
          }),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-lockfile-" });
        const stageDir = path.join(repoRoot, "stage");
        const stageLockfile = path.join(stageDir, "pnpm-lock.yaml");
        yield* fs.makeDirectory(stageDir);
        yield* fs.writeFileString(path.join(repoRoot, "pnpm-lock.yaml"), ROOT_LOCKFILE_FIXTURE);
        const ran: string[] = [];
        const seeds: string[] = [];
        const credentials: string[] = [];
        const storeDirs: Array<string | undefined> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          const { args, options } = command as unknown as ChildProcess.StandardCommand;
          ran.push(args.join(" "));
          // Without extendEnv a given env replaces the inherited one; without env the child inherits.
          const env =
            options.env === undefined
              ? process.env
              : options.extendEnv === true
                ? { ...process.env, ...options.env }
                : options.env;
          credentials.push(...CREDENTIAL_NAMES.filter((name) => name in env));
          storeDirs.push(env.pnpm_config_store_dir);
          return (
            args.includes("--lockfile-only")
              ? fs.readFileString(stageLockfile).pipe(
                  Effect.tap((seed) => Effect.sync(() => seeds.push(seed))),
                  Effect.andThen(fs.writeFileString(stageLockfile, resolved)),
                )
              : Effect.void
          ).pipe(Effect.as(mockProcess(0)));
        });

        const result = yield* installStagedDependencies({
          repoRoot,
          stageDir,
          label: "desktop app",
          sourceImporters: STAGE_SOURCE_IMPORTERS,
          verbose: false,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          // On Windows `vp` resolves to a shell command line; the spawner above reads plain args.
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.result,
        );

        assert.deepStrictEqual(seeds, [ROOT_LOCKFILE_FIXTURE]);
        assert.deepStrictEqual(ran, commands);
        assert.deepStrictEqual(credentials, []);
        assert.deepStrictEqual(
          storeDirs,
          commands.map(() => "/fixture/store"),
        );
        if (drift === undefined) {
          assert.isTrue(Result.isSuccess(result));
        } else {
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.instanceOf(result.failure, StageLockfileDriftError);
            assert.include(result.failure.message, drift);
          }
        }
      }),
    ),
  );

  it("stages only the externals of both bundles in merged packages", () => {
    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "mac",
        serverDependencies: {
          "@cursor/sdk": "1.0.22",
          "@anthropic-ai/claude-agent-sdk": "^0.3.170",
          "@ff-labs/fff-node": "0.9.4",
          "@opencode-ai/sdk": "^1.3.15",
          "@pierre/diffs": "1.3.0",
          "node-pty": "1.1.0",
        },
        desktopDependencies: {
          "@napi-rs/keyring": "1.3.0",
          "playwright-core": "1.60.0",
        },
        arch: "arm64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@cursor/sdk": "1.0.22",
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      },
    );

    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "linux",
        serverDependencies: { "@ff-labs/fff-node": "0.9.4", "node-pty": "1.1.0", effect: "4.0.0" },
        desktopDependencies: { "@crowecawcaw/xa11y": "0.13.0" },
        arch: "x64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@crowecawcaw/xa11y": "0.13.0",
        "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
        "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
      },
    );
  });

  it.effect("ships Cursor platform assets outside asar for spawning and native loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-helpers-" });
        const nodeModules = path.join(root, "node_modules");
        const destination = path.join(root, "resources/node_modules/@cursor");
        const cursorDirectory = symlinksSupported
          ? path.join(root, "store/@cursor")
          : path.join(nodeModules, "@cursor");
        yield* fs.makeDirectory(path.join(cursorDirectory, "sdk"), { recursive: true });
        if (symlinksSupported) {
          yield* fs.makeDirectory(path.join(nodeModules, "@cursor"), { recursive: true });
          yield* fs.symlink(
            path.join(cursorDirectory, "sdk"),
            path.join(nodeModules, "@cursor/sdk"),
          );
        }
        const helpers = [
          "sdk-darwin-arm64/bin/rg",
          "sdk-darwin-arm64/bin/cursorsandbox",
          "sdk-darwin-arm64/vendor/tree-sitter/index.js",
          "sdk-darwin-arm64/vendor/tree-sitter/binding.node",
          "sdk-darwin-arm64/vendor/tree-sitter-bash/binding.node",
          "sdk-darwin-arm64/package.json",
          "sdk-win32-x64/bin/rg.exe",
        ];
        for (const helper of helpers) {
          const source = path.join(cursorDirectory, helper);
          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* fs.writeFileString(source, "fixture helper", { mode: 0o755 });
        }
        yield* stageCursorSdkPlatformPackages(nodeModules, destination);
        for (const helper of helpers) {
          assert.equal(yield* fs.readFileString(path.join(destination, helper)), "fixture helper");
          const packagedPath = `node_modules/@cursor/${helper}`;
          assert.isTrue(
            DESKTOP_FILE_EXCLUSIONS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob.slice(1)),
            ),
          );
          assert.isTrue(
            WINDOWS_SERVER_ASAR_IGNORE_GLOBS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob),
            ),
          );
        }
      }),
    ),
  );

  it.effect("unpacks target Windows natives while excluding the other architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-windows-architecture-test-",
        });
        const sourceDir = path.join(tempDir, "server");
        const nativeFiles = [
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-x64/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-x64/pty.node",
          "node_modules/node-pty/prebuilds/linux-x64/pty.node",
        ];

        for (const nativeFile of nativeFiles) {
          const nativePath = path.join(sourceDir, nativeFile);
          yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
          yield* fs.writeFileString(nativePath, nativeFile.includes("linux") ? "\x7fELF" : "MZ");
        }

        const asarPath = path.join(tempDir, "server.asar");
        yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
        const unpackedRoot = `${asarPath}.unpacked`;

        assert.isTrue(
          yield* fs.exists(
            path.join(
              unpackedRoot,
              "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
            ),
          ),
        );
        assert.isTrue(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
          ),
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/linux-x64")),
        );
        assert.equal(
          extractFile(
            asarPath,
            path.join("node_modules", "node-pty", "prebuilds", "linux-x64", "pty.node"),
          ).toString(),
          "\x7fELF",
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-arm64")),
        );
        assert.isFalse(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64"),
          ),
        );
      }),
    ),
  );

  it.effect("reports missing Windows toolchain capabilities before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            const fails =
              childProcess.command === "rustc" ||
              childProcess.command === "powershell.exe" ||
              childProcess.command === pythonPath;
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          phase: "all",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { npm_config_python: pythonPath } }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "python", "msvc"]);
        assert.equal(error.rustTarget, "x86_64-pc-windows-msvc");
        assert.include(error.message, "Visual Studio Build Tools components");
      }),
    ),
  );

  it.effect("does not require MSVC when reusing a prebuilt Windows resource monitor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const commands: string[] = [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            commands.push(childProcess.command);
            return Effect.succeed(mockProcess(childProcess.command === "powershell.exe" ? 1 : 0));
          }),
        );

        yield* preflightWindowsDesktopBuild({
          arch: "x64",
          phase: "all",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    npm_config_python: pythonPath,
                    T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
                  },
                }),
              ),
            ),
          ),
        );

        assert.notInclude(commands, "powershell.exe");
      }),
    ),
  );

  it.effect("packages a finished stage without the Windows build toolchain", () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const childProcess = command as unknown as { readonly command: string };
          commands.push(childProcess.command);
          return Effect.succeed(mockProcess(childProcess.command === "tar.exe" ? 0 : 1));
        }),
      );

      yield* preflightWindowsDesktopBuild({
        arch: "x64",
        phase: "package",
        bundlesWslRuntime: true,
      }).pipe(
        Effect.provide(
          Layer.merge(spawner, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        ),
      );

      assert.deepStrictEqual(commands, ["tar.exe"]);
    }),
  );

  it.effect("rejects a PATH-discovered Python executable that is not Python 3", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-python2-preflight-" });
        const pythonPath = path.join(tempDir, "python");
        yield* fs.writeFileString(pythonPath, "python2");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            if (childProcess.command === "python") {
              return Effect.succeed(mockProcess(0, `${pythonPath}\n`));
            }
            if (childProcess.command === pythonPath) {
              return Effect.succeed(mockProcess(1));
            }
            return Effect.succeed(mockProcess(0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          phase: "all",
          bundlesWslRuntime: false,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
                }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["python"]);
      }),
    ),
  );

  // The fixture's t3code.exe is a text placeholder, not an executable. These
  // cases reach the native-load probe, so pin only that host-platform check to
  // Linux. Host-native paths and the real Windows tar/archive checks still run.
  it.effect("validates every ASAR-unpacked native in the packaged Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const secondAsarPath = path.join(path.dirname(fixture.generatedAsarPath), "second.asar");
        yield* packWindowsServerAsar({
          sourceDir: fixture.sourceDir,
          asarPath: secondAsarPath,
          arch: "x64",
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
        assert.deepStrictEqual(secondAsar, firstAsar);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "accepts an embedded archive with the Linux %s node-pty prebuild",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch,
          });
          const result = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          });

          assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "rejects a node-pty prebuild for the wrong architecture in a Linux %s archive",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch === "x64" ? "arm64" : "x64",
          });
          const error = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          }).pipe(Effect.flip);

          assert.instanceOf(error, WindowsPackagedPayloadValidationError);
          assert.equal(error.reason, "wsl-runtime-invalid");
        }),
      ),
  );

  it.effect("rejects an embedded archive built for a different release version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: "9.9.9",
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("rejects a Windows package missing its expected WSL runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-missing");
      }),
    ),
  );

  it.effect("rejects an embedded archive without the Linux node-pty binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "missing-pty",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
        assert.deepStrictEqual(error.missingFiles, [
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/build/Release/pty.node`,
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/prebuilds/linux-x64/pty.node`,
        ]);
      }),
    ),
  );

  it.effect("rejects an emitted WSL archive whose sidecar digest does not match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "bad-digest",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("probes fff through the packaged Windows primary instead of helper executables", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
        readonly extendEnv?: boolean;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const primaryProbe = commands.find(
          (command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1",
        );
        if (primaryProbe === undefined) return assert.fail("Windows primary probe was not spawned");

        assert.equal(
          primaryProbe.command,
          path.join(fixture.packagedAppDir, fixture.appExecutableName),
        );
        assert.deepStrictEqual(primaryProbe.args.slice(0, 3), [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
        ]);
        assert.include(primaryProbe.args[3], "FileFinder.create");
        assert.equal(
          primaryProbe.args[4],
          path.join(
            fixture.packagedAppDir,
            "resources/server.asar/node_modules/@ff-labs/fff-node/dist/index.js",
          ),
        );
        assert.equal(primaryProbe.options.cwd, fixture.packagedAppDir);
        assert.isFalse(primaryProbe.options.extendEnv);
        assert.notProperty(primaryProbe.options.env, "NODE_PATH");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("refuses a Linux build on a host that cannot build the browser secret helper", () => {
    const commands: Array<{ readonly command: string }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      const error = yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "x64",
        verbose: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, LinuxBrowserSecretHostError);
      assert.equal(error.hostPlatform, "darwin");
      assert.include(error.message, "Linux host");
      assert.lengthOf(commands, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.Architecture, "arm64"),
        ),
      ),
    );
  });

  it.effect("skips the primary native probe for cross-architecture Windows payloads", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        assert.isFalse(
          commands.some(
            (command) =>
              command.command === NodePath.join(fixture.packagedAppDir, fixture.appExecutableName),
          ),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === process.execPath &&
              command.args.includes("--no-global-search-paths"),
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const executablePath = path.join(fixture.packagedAppDir, fixture.appExecutableName);
        yield* fs.remove(executablePath);

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPrimaryNativeProbeError);
        assert.equal(error.executablePath, executablePath);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  it.effect("rejects a packaged sidecar whose ASAR-unpacked native is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unpacked-native-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);
      }),
    ),
  );

  it.effect("rejects directories in place of packaged executable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const nativePath = path.join(
          fixture.packagedAppDir,
          "resources/server.asar.unpacked/node_modules/native/addon.node",
        );
        yield* fs.remove(nativePath);
        yield* fs.makeDirectory(nativePath);

        const nativeError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(nativeError, WindowsPackagedPayloadValidationError);
        assert.equal(nativeError.reason, "unpacked-native-missing");
        assert.deepStrictEqual(nativeError.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);

        yield* fs.remove(nativePath, { recursive: true });
        yield* fs.writeFileString(nativePath, "native-binary");
        const resourceMonitorPath = path.join(
          fixture.packagedAppDir,
          "resources/resource-monitor/t3-resource-monitor.exe",
        );
        yield* fs.remove(resourceMonitorPath);
        yield* fs.makeDirectory(resourceMonitorPath);

        const resourceMonitorError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(resourceMonitorError, WindowsPackagedPayloadValidationError);
        assert.equal(resourceMonitorError.reason, "resource-monitor-missing");
        assert.deepStrictEqual(resourceMonitorError.missingFiles, [
          "resource-monitor/t3-resource-monitor.exe",
        ]);
      }),
    ),
  );

  it.effect("rejects a Windows payload that regresses above the file-count budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          fileLimit: 2,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "file-limit-exceeded");
        assert.isAbove(error.fileCount ?? 0, 2);
      }),
    ),
  );

  it.effect("rejects a sidecar whose extracted server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        const error = yield* verifyPackagedBundleIsSelfContained({
          asarPath: path.join(fixture.packagedAppDir, "resources", WINDOWS_SERVER_ASAR_RESOURCE),
          verbose: false,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "t3code-deliberately-missing-package");
      }),
    ),
  );

  it.effect("rejects a macOS app whose packaged server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeMacPayloadFixture({
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        const error = yield* validateMacPackagedPayload({
          stageDistDir: fixture.stageDistDir,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "t3code-deliberately-missing-package");
      }),
    ),
  );

  it.effect("accepts a macOS app whose packaged server bundle resolves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeMacPayloadFixture({});
        yield* validateMacPackagedPayload({ stageDistDir: fixture.stageDistDir });
      }),
    ),
  );

  it.effect("runs the packaged server without the signing step's credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            vi.stubEnv("CSC_KEY_PASSWORD", "fixture-password");
            vi.stubEnv("Release_Signing_Token", "fixture-token");
          }),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
        const fixture = yield* makeMacPayloadFixture({
          serverEntrySource: [
            "const visible = Object.keys(process.env).filter((name) => /password|token/i.test(name));",
            'if (visible.length > 0) { console.error(`credentials visible: ${visible.join(",")}`); process.exit(1); }',
            "",
          ].join("\n"),
        });
        yield* validateMacPackagedPayload({ stageDistDir: fixture.stageDistDir });
      }),
    ),
  );

  it.effect("rejects a macOS stage without a packaged app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageDistDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mac-payload-test-" });
        const error = yield* validateMacPackagedPayload({ stageDistDir }).pipe(Effect.flip);

        assert.instanceOf(error, MacPackagedAppMissingError);
      }),
    ),
  );

  it.effect("rejects a macOS app without app.asar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageDistDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mac-payload-test-" });
        yield* fs.makeDirectory(`${stageDistDir}/mac-arm64/T3.CodeShip.app/Contents/Resources`, {
          recursive: true,
        });
        const error = yield* validateMacPackagedPayload({ stageDistDir }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
      }),
    ),
  );

  it.effect("leaves the bundle self-check of a cross-built payload to the verify job", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "abc1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "com.t3tools.t3code",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/t3code.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration, {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.com.t3tools.t3code</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.match(entitlements, /<key>com\.apple\.security\.device\.camera<\/key>\s*<true\/>/u);
    assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/u);
    assert.notInclude(entitlements, "keychain-access-groups");
    assert.notInclude(entitlements, "com.apple.developer.web-browser.public-key-credential");
  });

  it("grants in-app browser passkey entitlements only when the provisioning profile does", () => {
    const configuration = { appId: "com.t3tools.t3code", teamId: "ABC1234567" };
    const profile = (entitlements: string, outside = "") =>
      `0\x82\x1f\x9a\x06\t*\x86H<?xml version="1.0"?><plist version="1.0"><dict>${outside}<key>Entitlements</key><dict>${entitlements}</dict></dict></plist>\x00\x01`;
    const teamWildcardGroups = `<key>keychain-access-groups</key>
      <array>
        <string>ABC1234567.*</string>
        <string>com.apple.token</string>
      </array>`;

    assert.deepStrictEqual(resolveMacWebAuthnEntitlements(profile(""), configuration), {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile("<key>keychain-access-groups</key><array><string>OTHERTEAM1.*</string></array>"),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `<!-- ${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key><true/> -->
          <key>com.apple.developer.web-browser.public-key-credential</key><false/>`,
          teamWildcardGroups,
        ),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key>
          <true/>`,
        ),
        configuration,
      ),
      {
        touchIdKeychainAccessGroup: "ABC1234567.com.t3tools.t3code.webauthn",
        browserPasskeys: true,
      },
    );

    const entitlements = renderMacPasskeyEntitlements(
      { ...configuration, rpDomains: ["clerk.example.com"], provisioningProfilePath: "" },
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}<key>com.apple.developer.web-browser.public-key-credential</key><true/>`,
        ),
        configuration,
      ),
    );
    assert.match(
      entitlements,
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>ABC1234567\.com\.t3tools\.t3code\.webauthn<\/string>\s*<\/array>/u,
    );
    assert.match(
      entitlements,
      /<key>com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\/>/u,
    );
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    const captureError = (env: Readonly<Record<string, string | undefined>>) => {
      try {
        resolveMacPasskeySigningConfiguration(env);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected passkey signing configuration to fail.");
    };

    const missingProfileError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
    });
    assert.instanceOf(missingProfileError, MissingMacPasskeyProvisioningProfileError);
    assert.equal(
      missingProfileError.message,
      "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.",
    );

    const unsafeDomain =
      "https://domain-user:domain-secret@example.clerk.accounts.dev/path?token=query-secret";
    const invalidDomainError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
    });
    assert.instanceOf(invalidDomainError, InvalidMacPasskeyRpDomainError);
    assert.equal(invalidDomainError.reason, "scheme-not-allowed");
    assert.equal(invalidDomainError.inputLength, unsafeDomain.length);
    assert.equal(invalidDomainError.message, "Invalid passkey RP domain (scheme-not-allowed).");
    assert.notProperty(invalidDomainError, "domain");
    assert.notProperty(invalidDomainError, "cause");
    const serializedInvalidDomainError = JSON.stringify(invalidDomainError);
    assert.notInclude(serializedInvalidDomainError, unsafeDomain);
    assert.notInclude(serializedInvalidDomainError, "domain-user");
    assert.notInclude(serializedInvalidDomainError, "domain-secret");
    assert.notInclude(serializedInvalidDomainError, "query-secret");
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(invalidPublishableKeyError.message, "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.");
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  it.effect("signs Windows builds with signtool on Windows and the jsign hook elsewhere", () =>
    Effect.gen(function* () {
      const signedWinConfig = (hostPlatform: string) =>
        createBuildConfig("win", "nsis", "1.2.3", true, false, undefined, undefined).pipe(
          Effect.map((config) => config.win as Record<string, unknown>),
          Effect.provideService(HostProcess.Platform, hostPlatform),
        );

      const onWindows = yield* signedWinConfig("win32");
      assert.equal((onWindows.azureSignOptions as Record<string, unknown>).publisherName, "T3");
      assert.notProperty(onWindows, "signtoolOptions");

      const onLinux = yield* signedWinConfig("linux");
      assert.notProperty(onLinux, "azureSignOptions");
      const signtoolOptions = onLinux.signtoolOptions as Record<string, unknown>;
      assert.match(signtoolOptions.sign as string, /scripts[\\/]lib[\\/]windows-jsign\.ts$/);
      assert.deepStrictEqual(signtoolOptions.signingHashAlgorithms, ["sha256"]);
      assert.deepStrictEqual(signtoolOptions.publisherName, ["T3"]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "T3",
              AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
              AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
              AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "account",
            },
          }),
        ),
      ),
    ),
  );

  it("parses Windows bsdtar member listings with CRLF line endings", () => {
    assert.deepStrictEqual(
      parseWslRuntimeArchiveMembers("./t3-1.2.3-linux-x64/t3\r\nt3-1.2.3-linux-x64/client/\r\n"),
      ["t3-1.2.3-linux-x64/t3", "t3-1.2.3-linux-x64/client"],
    );
  });

  it.effect("stages the Linux CLI archive verbatim with its SHA-256 sidecar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wsl-runtime-stage-" });
        const sourceArchivePath = yield* makeLinuxCliArchiveFixture({
          root,
          stem: "t3-1.2.3-linux-x64",
        });
        const stageAppDir = path.join(root, "app");
        const archivePath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from);
        const hashPath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from);

        yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });

        const [source, staged] = yield* Effect.all([
          fs.readFile(sourceArchivePath),
          fs.readFile(archivePath),
        ]);
        assert.deepStrictEqual(staged, source);
        const hash = yield* fs.readFileString(hashPath);
        assert.equal(hash, `${NodeCrypto.createHash("sha256").update(source).digest("hex")}\n`);
      }),
    ),
  );

  const stageElectronFixture = Effect.fn("stageElectronFixture")(function* (
    zipBytes: (archiveName: string) => Uint8Array,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electron-dist-" });
    const electronPackageDir = path.join(root, "electron");
    const archiveNames = ["x64", "arm64"].map(
      (arch) => `electron-v${desktopElectronVersion}-darwin-${arch}.zip`,
    );
    const published = (archiveName: string) => new TextEncoder().encode(archiveName);
    yield* fs.makeDirectory(electronPackageDir);
    yield* fs.writeFileString(
      path.join(electronPackageDir, "package.json"),
      JSON.stringify({ version: desktopElectronVersion }),
    );
    yield* fs.writeFileString(
      path.join(electronPackageDir, "checksums.json"),
      JSON.stringify(
        Object.fromEntries(
          archiveNames.map((name) => [
            name,
            NodeCrypto.createHash("sha256").update(published(name)).digest("hex"),
          ]),
        ),
      ),
    );
    const distDir = path.join(root, ELECTRON_DIST_DIR);
    const exit = yield* Effect.exit(
      stageElectronDist({
        electronPackageDir,
        version: desktopElectronVersion,
        platform: "mac",
        arch: "universal",
        distDir,
        download: (_version, archiveName, destination) =>
          fs.writeFile(destination, zipBytes(archiveName)).pipe(Effect.orDie),
      }),
    );
    return { exit, distDir, archiveNames, published };
  });

  it.effect("stages the Electron zip of each architecture a universal app unpacks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { exit, distDir, archiveNames, published } = yield* stageElectronFixture(
          (archiveName) => new TextEncoder().encode(archiveName),
        );

        assert.isTrue(Exit.isSuccess(exit));
        assert.deepStrictEqual(
          (yield* fs.readDirectory(distDir)).toSorted(),
          archiveNames.toSorted(),
        );
        for (const name of archiveNames) {
          assert.deepStrictEqual(yield* fs.readFile(NodePath.join(distDir, name)), published(name));
        }
      }),
    ),
  );

  it.effect("rejects an Electron zip whose SHA-256 differs from the locked electron package", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { exit } = yield* stageElectronFixture((archiveName) =>
          new TextEncoder().encode(archiveName.endsWith("arm64.zip") ? "tampered" : archiveName),
        );

        const error = Option.getOrUndefined(Exit.findErrorOption(exit));
        assert.instanceOf(error, ElectronDistStageError);
        assert.include(
          error.message,
          `electron-v${desktopElectronVersion}-darwin-arm64.zip has SHA-256`,
        );
      }),
    ),
  );

  it.effect("rejects universal builds on Linux and Windows before staging binaries", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "win"] as const) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some(platform),
            target: Option.none(),
            arch: Option.some("universal"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            keepStage: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslRuntime: Option.none(),
            phase: Option.none(),
            stageDir: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildArchitectureError);
        assert.deepStrictEqual(error.supportedArchitectures, ["x64", "arm64"]);
      }
    }),
  );

  it.effect("rejects Mac App Store targets before staging anything", () =>
    Effect.gen(function* () {
      for (const target of ["mas", "mas-dev"]) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some("mac"),
            target: Option.some(target),
            arch: Option.some("arm64"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            keepStage: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslRuntime: Option.none(),
            phase: Option.none(),
            stageDir: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildTargetError);
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
        phase: Option.none(),
        stageDir: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );

  it.effect.each([
    {
      name: "a stage phase without --stage-dir",
      phase: "stage",
      stageDir: undefined,
      signed: false,
      wslRuntime: undefined,
      error: "StageDirRequiredError",
    },
    {
      name: "a package phase without --stage-dir",
      phase: "package",
      stageDir: undefined,
      signed: false,
      wslRuntime: undefined,
      error: "StageDirRequiredError",
    },
    {
      name: "a signed stage phase",
      phase: "stage",
      stageDir: "stage",
      signed: true,
      wslRuntime: undefined,
      error: "DesktopStagePhaseOptionError",
    },
    {
      name: "a stage phase that would drop the WSL runtime",
      phase: "stage",
      stageDir: "stage",
      signed: false,
      wslRuntime: "t3-linux-x64.tar.gz",
      error: "DesktopStagePhaseOptionError",
    },
  ] as const)("rejects $name", ({ phase, stageDir, signed, wslRuntime, error }) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveBuildOptions({
          platform: Option.some("win"),
          target: Option.none(),
          arch: Option.some("x64"),
          buildVersion: Option.none(),
          outputDir: Option.none(),
          skipBuild: Option.none(),
          keepStage: Option.none(),
          signed: Option.some(signed),
          verbose: Option.none(),
          mockUpdates: Option.none(),
          mockUpdateServerPort: Option.none(),
          wslRuntime: Option.fromUndefinedOr(wslRuntime),
          phase: Option.some(phase),
          stageDir: Option.fromUndefinedOr(stageDir),
        }),
      );

      assert.equal(failure._tag, error);
    }),
  );
});

it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect.skipIf(!symlinksSupported)("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves packaged app directories from the dir target", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dir-artifact-" });
    const stage = path.join(root, "stage");
    const output = path.join(root, "output");
    const app = path.join("mac-arm64", "T3.CodeShip.app", "Contents");
    yield* fs.makeDirectory(path.join(stage, app), { recursive: true });
    yield* fs.writeFileString(path.join(stage, app, "Info.plist"), "built-app");
    yield* fs.writeFileString(path.join(stage, "builder-debug.yml"), "debug");
    const copied = yield* copyDesktopBuildArtifacts(stage, output, true);
    assert.include(copied, path.join(output, "mac-arm64"));
    assert.equal(yield* fs.readFileString(path.join(output, app, "Info.plist")), "built-app");
    assert.equal(yield* fs.readFileString(path.join(stage, app, "Info.plist")), "built-app");
    yield* fs.remove(path.join(stage, app, "Info.plist"));
    yield* fs.writeFileString(path.join(stage, app, "New.plist"), "rebuilt-app");
    yield* copyDesktopBuildArtifacts(stage, output, true);
    assert.isFalse(yield* fs.exists(path.join(output, app, "Info.plist")));
    assert.equal(yield* fs.readFileString(path.join(output, app, "New.plist")), "rebuilt-app");
    const filesOnly = yield* copyDesktopBuildArtifacts(stage, path.join(root, "files-only"));
    assert.deepEqual(filesOnly, [path.join(root, "files-only", "builder-debug.yml")]);
    assert.isFalse(yield* fs.exists(path.join(root, "files-only", "mac-arm64")));
    yield* fs.remove(path.join(stage, "mac-arm64"), { recursive: true });
    yield* fs.writeFileString(path.join(stage, "mac-arm64"), "flattened");
    yield* copyDesktopBuildArtifacts(stage, output, true);
    assert.equal(yield* fs.readFileString(path.join(output, "mac-arm64")), "flattened");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.skipIf(!symlinksSupported)("preserves relative links when replacing dir artifacts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dir-artifact-links-" });
    const stage = path.join(root, "stage");
    const output = path.join(root, "output");
    const app = path.join("mac-arm64", "T3.CodeShip.app", "Contents");
    yield* fs.makeDirectory(path.join(stage, app), { recursive: true });
    yield* fs.writeFileString(path.join(stage, app, "Info.plist"), "built-app");
    yield* fs.symlink("Info.plist", path.join(stage, app, "Current"));
    yield* copyDesktopBuildArtifacts(stage, output, true);
    assert.equal(yield* fs.readLink(path.join(output, app, "Current")), "Info.plist");
    assert.equal(yield* fs.readFileString(path.join(output, app, "Current")), "built-app");

    yield* fs.remove(path.join(stage, app, "Current"));
    yield* fs.writeFileString(path.join(stage, app, "New.plist"), "rebuilt-app");
    yield* fs.symlink("New.plist", path.join(stage, app, "Current"));
    yield* copyDesktopBuildArtifacts(stage, output, true);
    assert.equal(yield* fs.readLink(path.join(output, app, "Current")), "New.plist");
    assert.equal(yield* fs.readFileString(path.join(output, app, "Current")), "rebuilt-app");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
