import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type ManagedPolicyDocument, ServerSelfUpdateError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { linkDirectory } from "@t3tools/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly preflightMigratesDatabase?: boolean;
  readonly preflightDuration?: Duration.Input;
  readonly preflightStarted?: Deferred.Deferred<void>;
  readonly beforeDownload?: Effect.Effect<void>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  readonly policy?: ManagedPolicyDocument;
  /** What the server's parked work waits for: the launcher committing this version. */
  readonly activation?: Effect.Effect<void>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

// The process list `lsof` prints when no t3 runtime is running.
const otherProcesses = ProcessRunner.ProcessRunner.of({
  run: () =>
    Effect.succeed({
      stdout: "p42\nftxt\nn/bin/sh\n",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (order: string[], beforeDownload?: Effect.Effect<void>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("/SHA256SUMS")) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${hex}  t3-1.1.0-linux-x64.tar.gz\n`),
        );
      }
      if (beforeDownload) yield* beforeDownload;
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const order: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "lsof") return yield* otherProcesses.run(input);
        if (input.command === "sh" || input.command === "tar") {
          if (input.command === "sh") {
            // Emulate the POSIX promotion transaction on every test host.
            const [parentDir, version, stagingDir] = input.args.slice(-3);
            if (!parentDir || !version || !stagingDir)
              return yield* Effect.die("missing runtime paths");
            yield* fs.rename(stagingDir, path.join(parentDir, version)).pipe(Effect.orDie);
          } else {
            order.push("extract");
            const stagingDir = input.args[input.args.indexOf("-C") + 1];
            if (stagingDir === undefined) return yield* Effect.die("missing tar target");
            yield* fs
              .writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n")
              .pipe(Effect.orDie);
          }
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        if (options.preflightStarted) yield* Deferred.succeed(options.preflightStarted, undefined);
        if (options.preflightDuration !== undefined) {
          // Like the real runner, fail once the caller's timeout elapses.
          const timeout = Duration.fromInputUnsafe(input.timeout ?? "60 seconds");
          const finished = yield* Effect.sleep(options.preflightDuration).pipe(
            Effect.timeoutOption(timeout),
          );
          if (finished._tag === "None") {
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: Duration.toMillis(timeout),
            });
          }
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0", reason: "local update required" }
            : {
                status: "ready",
                version: "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
                migratesDatabase: options.preflightMigratesDatabase ?? true,
              };
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    settledOutcome: undefined,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
    reportPreparing: Effect.void,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(HttpClient.HttpClient, releaseHttpClient(order, options.beforeDownload)),
    Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    // Never the real PATH or home: their `t3` launchers belong to the developer's install.
    Effect.provideService(HostProcess.Environment, options.environment ?? {}),
    Effect.provideService(HostProcess.HomeDirectory, options.homeDirectory ?? baseDir),
    Effect.provideService(ServerActivation.ServerActivation, options.activation),
    Effect.provide(
      Layer.merge(
        ServerConfig.layer({ ...config, mode: options.mode ?? "web" }),
        ManagedPolicy.layerTest(options.policy),
      ),
    ),
  );
  return { selfUpdate, order, baseDir };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  // regression: #5181 make remote updates rollback-safe
  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("keeps the local CLI in place when service preflight blocks an update", () =>
    Effect.gen(function* () {
      const { selfUpdate, order, baseDir } = yield* makeHarness({ preflight: "blocked" });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const version = "1.1.0";
      const directory = path.join(baseDir, "runtime", "versions", version);
      const entry = path.join(directory, "t3");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(entry, "cached CLI");
      yield* fs.writeFileString(path.join(directory, ".install-complete"), version);

      const result = yield* selfUpdate.update({ targetVersion: version }).pipe(Effect.flip);
      expect(result.reason).toBe("local update required");
      expect(order).toEqual(["preflight"]);
      expect(yield* fs.readFileString(entry)).toBe("cached CLI");
    }),
  );

  it.effect("refuses every update when the managed policy turns updates off", () =>
    Effect.gen(function* () {
      const policy: ManagedPolicyDocument = {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { updates: { mode: "off" } },
      };
      const service = yield* makeHarness({ policy });
      const desktop = yield* makeHarness({
        mode: "desktop",
        policy,
        desktopAppUpdate: {
          available: true,
          notAppliedVersion: Effect.undefined,
          cancel: () => Effect.void,
          run: () => Effect.die("unexpected desktop app update run"),
          commit: () => Effect.never,
        },
      });
      for (const harness of [service, desktop]) {
        expect(
          (yield* harness.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toBe("Example Corp manages T3.CodeShip updates.");
      }
      expect([...service.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("lets a user start an update, but only to stable without nightly", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { updates: { mode: "auto", allowNightly: false } },
        },
      });
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.2.0-nightly.20261028.1" }).pipe(Effect.flip))
          .reason,
      ).toBe("Example Corp manages T3.CodeShip updates. Only stable releases can be installed.");
      expect(order).toEqual([]);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).updateId).toBe("launcher-id");
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          notAppliedVersion: Effect.undefined,
          cancel: () => Effect.void,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      expect(order).toEqual([]);
    }),
  );

  it.effect("hands nothing to the launcher when the last check before it fails", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      const refused = yield* selfUpdate
        .update({ targetVersion: "1.1.0" }, undefined, undefined, () =>
          Effect.fail(new ServerSelfUpdateError({ reason: "a chat started background work" })),
        )
        .pipe(Effect.flip);

      expect(refused.reason).toBe("a chat started background work");
      expect(order).not.toContain("accept");
      // Not left in flight: the next update goes ahead.
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).updateId).toBe("launcher-id");
    }),
  );

  it.effect.each([false, true] as const)(
    "tells the launcher whether the target migrates the database (%s)",
    (migratesDatabase) =>
      Effect.gen(function* () {
        const requests: Array<{ readonly migratesDatabase?: boolean }> = [];
        const { selfUpdate } = yield* makeHarness({
          preflightMigratesDatabase: migratesDatabase,
          requestUpdate: (input) =>
            Effect.sync(() => {
              requests.push(input);
              return "launcher-id";
            }),
        });
        yield* selfUpdate.update({ targetVersion: "1.1.0" });
        expect(requests.map((request) => request.migratesDatabase)).toEqual([migratesDatabase]);
      }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );

  // regression: #28198 a slow staged preflight on a loaded host no longer fails the update
  it.effect("waits for a staged preflight that takes a minute on a loaded host", () =>
    Effect.gen(function* () {
      const preflightStarted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        preflightDuration: "60 seconds",
        preflightStarted,
      });
      const update = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(preflightStarted);
      yield* TestClock.adjust("60 seconds");
      const exit = yield* Fiber.await(update);
      expect(exit._tag === "Failure" ? String(exit.cause) : "launcher handoff").toBe(
        "launcher handoff",
      );
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("keeps preparing after the progress stream closes", () =>
    Effect.gen(function* () {
      const releaseDownload = yield* Deferred.make<void>();
      const sawDownloading = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        beforeDownload: Deferred.await(releaseDownload),
        requestUpdate: () =>
          Effect.sync(() => {
            order.push("accept");
          }).pipe(Effect.andThen(Deferred.succeed(accepted, undefined)), Effect.as("launcher-id")),
      });

      const consumed = yield* ServerSelfUpdate.updateProgressStream(selfUpdate, {
        targetVersion: "1.1.0",
      }).pipe(
        Stream.tap((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(sawDownloading, undefined)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* Deferred.await(sawDownloading);
      yield* Fiber.interrupt(consumed);
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );

      yield* Deferred.succeed(releaseDownload, undefined);
      yield* Deferred.await(accepted);
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
    }),
  );

  it.effect("pre-stages via prepare and activates without redownloading or re-preflighting", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness();

      const prepared = yield* selfUpdate.prepare({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(`prepare:${stage}`)),
      );
      expect(prepared.targetVersion).toBe("1.1.0");
      expect(order).toEqual(["download", "extract", "preflight"]);
      expect(stages).toEqual(["prepare:downloading"]);

      // A second prepare for the same version hits the in-memory staged cache immediately.
      const cached = yield* selfUpdate.prepare({ targetVersion: "1.1.0" });
      expect(cached).toEqual(prepared);
      expect(order).toEqual(["download", "extract", "preflight"]);

      // Activating hands off directly without redownloading or rerunning preflight.
      const result = yield* selfUpdate.activatePrepared(prepared, (stage) =>
        Effect.sync(() => void stages.push(`activate:${stage}`)),
      );
      expect(result).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      expect(stages).toEqual(["prepare:downloading", "activate:installing"]);
    }),
  );

  it.effect(
    "reuses a prepared runtime from update and resets inFlight when beforeHandoff fails",
    () =>
      Effect.gen(function* () {
        const { selfUpdate, order } = yield* makeHarness();
        const prepared = yield* selfUpdate.prepare({ targetVersion: "1.1.0" });
        expect(order).toEqual(["download", "extract", "preflight"]);

        const refused = yield* selfUpdate
          .activatePrepared(prepared, undefined, undefined, () =>
            Effect.fail(new ServerSelfUpdateError({ reason: "a chat is answering" })),
          )
          .pipe(Effect.flip);
        expect(refused.reason).toBe("a chat is answering");
        expect(order).toEqual(["download", "extract", "preflight"]);

        // inFlight was reset, and update reuses the staged runtime without redownloading.
        const result = yield* selfUpdate.update({ targetVersion: "1.1.0" });
        expect(result.updateId).toBe("launcher-id");
        expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      }),
  );
});

/** An `lsof` listing in which no process runs a pinned runtime. */

/** Completed runtimes whose sentinels date from the epoch, so a prune a day later may remove them. */
const writeSettledRuntimes = Effect.fn("test.write_settled_runtimes")(function* (
  versionsDir: string,
  versions: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const version of versions) {
    const directory = path.join(versionsDir, version);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(path.join(directory, "t3"), "");
    const sentinel = path.join(directory, ".install-complete");
    yield* fs.writeFileString(sentinel, `${version}\n`);
    yield* fs.utimes(sentinel, 0, 0);
  }
});

it.layer(NodeServices.layer)("moving launchers when a self-update activates", (it) => {
  const replacedVersion = "0.0.1";
  const newerVersion = "9999.0.0";

  // regression: AB#7122 a self-updated service left `t3` on the replaced runtime
  // POSIX symlink launchers on a colon-separated PATH; Windows uses `t3.cmd` shims.
  it.effect.skipIf(isWindowsHost)(
    "moves every launcher on the replaced runtime once committed, then prunes that runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launchers-on-update-" });
        const pathBin = path.join(tempDir, "bin");
        const newerBin = path.join(tempDir, "newer-bin");
        const environment = { PATH: [newerBin, pathBin].join(":") };
        const activated = yield* Deferred.make<void>();
        // Activation runs on the fiber of the work parked behind it, so awaiting that fiber
        // waits for exactly that work.
        const parked: Array<Fiber.Fiber<unknown, unknown>> = [];
        const { baseDir } = yield* makeHarness({
          activation: Effect.fiber.pipe(
            Effect.tap((fiber) => Effect.sync(() => parked.push(fiber))),
            Effect.andThen(Deferred.await(activated)),
          ),
          environment,
          homeDirectory: tempDir,
          // Prune reads the process list from `lsof` here, not from the host's /proc.
          platform: "darwin",
        });
        const versionsDir = path.join(baseDir, "runtime", "versions");
        const runtimeEntry = (version: string) => path.join(versionsDir, version, "t3");
        yield* writeSettledRuntimes(versionsDir, [
          replacedVersion,
          packageJson.version,
          newerVersion,
        ]);
        const homeAlias = path.join(tempDir, "home-alias");
        yield* linkDirectory(baseDir, homeAlias);
        // Off PATH, so only the install script's records name these.
        const recordedLauncher = path.join(tempDir, "opt", "t3");
        const aliasLauncher = path.join(tempDir, "alias-bin", "t3");
        const pathLauncher = path.join(pathBin, "t3");
        const newerLauncher = path.join(newerBin, "t3");
        const launchers = [recordedLauncher, aliasLauncher, pathLauncher, newerLauncher];
        for (const launcher of launchers) {
          yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        }
        yield* fs.symlink(runtimeEntry(replacedVersion), recordedLauncher);
        // Prune resolves this one into the home; so must the move.
        yield* fs.symlink(
          path.join(homeAlias, "runtime", "versions", replacedVersion, "t3"),
          aliasLauncher,
        );
        yield* fs.symlink(runtimeEntry(replacedVersion), pathLauncher);
        // Someone moved this one past the service; the service never moves it back.
        yield* fs.symlink(runtimeEntry(newerVersion), newerLauncher);
        yield* fs.writeFileString(
          path.join(baseDir, "runtime", "launchers"),
          `${recordedLauncher}\n${aliasLauncher}\n`,
        );
        yield* TestClock.setTime(24 * 60 * 60 * 1000);
        const readLaunchers = Effect.forEach(launchers, (launcher) =>
          fs.readLink(launcher).pipe(
            Effect.map((target) => fs.realPath(target)),
            Effect.flatten,
          ),
        );
        const replaced = yield* fs.realPath(runtimeEntry(replacedVersion));
        const committed = yield* fs.realPath(runtimeEntry(packageJson.version));
        const newer = yield* fs.realPath(runtimeEntry(newerVersion));

        expect(yield* readLaunchers).toEqual([replaced, replaced, replaced, newer]);
        yield* Deferred.succeed(activated, undefined);
        yield* Fiber.awaitAll(parked);

        expect(yield* readLaunchers).toEqual([committed, committed, committed, newer]);
        expect((yield* fs.readDirectory(versionsDir)).toSorted()).toEqual(
          [packageJson.version, newerVersion].toSorted(),
        );
      }),
  );
});

it.layer(NodeServices.layer)("pruning runtimes on start", (it) => {
  const staleVersion = "0.0.1";

  const pruneOnStart = Effect.fn("test.prune_on_start")(function* (input: {
    readonly executable: "own runtime" | "elsewhere";
    readonly managed?: boolean;
    readonly symlinkedHome?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prune-on-start-" });
    const realHome = path.join(tempDir, "home");
    const baseDir = input.symlinkedHome ? path.join(tempDir, "linked-home") : realHome;
    const versionsDir = path.join(baseDir, "runtime", "versions");
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    yield* writeSettledRuntimes(path.join(realHome, "runtime", "versions"), [
      staleVersion,
      packageJson.version,
    ]);
    if (input.symlinkedHome) yield* linkDirectory(realHome, baseDir);
    // Like `process.execPath`, the running runtime is reported by its real path.
    const executablePath =
      input.executable === "own runtime"
        ? yield* fs.realPath(path.join(versionsDir, packageJson.version, "t3"))
        : "/usr/local/bin/node";
    const removed = yield* ServerSelfUpdate.pruneRuntimesOnStart({
      baseDir,
      managed: input.managed ?? false,
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(ProcessRunner.ProcessRunner, otherProcesses),
    );
    return { removed, remaining: (yield* fs.readDirectory(versionsDir)).toSorted() };
  });

  // The SSH launcher runs `t3 serve` straight from the pinned runtime, with no boot service.
  it.effect("prunes for a server started from its home's pinned runtime", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "own runtime" });
      expect(removed).toEqual([staleVersion]);
      expect(remaining).toEqual([packageJson.version]);
    }),
  );

  it.effect("recognizes its runtime through a symlinked T3 home", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "own runtime", symlinkedHome: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("prunes for a boot-service server wherever it runs from", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "elsewhere", managed: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("leaves runtimes alone for an unmanaged server started elsewhere", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "elsewhere" });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );
});

it("a host crosses tracks only to a release that knows its whole database", () => {
  const cross = (
    serverVersion: string,
    targetVersion: string,
    targetDatabaseMigration: number | undefined,
    databaseMigration = 72,
  ) =>
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion,
      targetVersion,
      targetDatabaseMigration,
      databaseMigration: () => databaseMigration,
    });
  const nightly = "0.1.4-nightly.20261027.3796";

  expect(cross(nightly, "0.1.4", 72)).toBeNull();
  // Another client moved this host to a newer Nightly after the switch was planned.
  expect(cross(nightly, "0.1.4", 72, 73)).toContain("does not support yet");
  expect(cross(nightly, "0.1.4", undefined)).toContain("Cannot confirm");
  // A Stable tag can carry a migration the latest Nightly lacks.
  expect(cross("0.1.4", nightly, 72, 73)).toContain("does not support yet");
  expect(cross("0.1.3", "0.1.4", undefined)).toBeNull();
  // A database that exists but cannot be read proves nothing.
  expect(
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion: nightly,
      targetVersion: "0.1.4",
      targetDatabaseMigration: 72,
      databaseMigration: () => undefined,
    }),
  ).toContain("Cannot confirm");
});
