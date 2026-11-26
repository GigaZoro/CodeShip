import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost } from "./sdk.ts";
import {
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
} from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus } from "./status.ts";

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (catalog: Record<string, unknown>, usage?: Record<string, unknown>) => {
  const host: MuseSdkHost = {
    initializeResult: { grantedCapabilities: [] },
    connection: {
      request: vi.fn(async (method) => (method === "usage/read" ? { usage } : catalog)),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-wonder-1.0",
      displayLabel: "muse-wonder-1.0",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("names why the version check failed, without credentials or an SDK host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("license check failed: Bearer secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toBe(
          "Muse Code CLI is installed but failed to run: license check failed: Bearer [redacted]",
        );
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect.each([
    {
      scenario: "after a version was known",
      lastKnownVersion: "1.0.2",
      expected: { status: "ready", version: "1.0.2" },
    },
    {
      scenario: "with no known version",
      lastKnownVersion: null,
      expected: { status: "error", version: null },
    },
  ] as const)("a `--version` that times out $scenario", ({ lastKnownVersion, expected }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(900_000_301),
            exitCode: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const fiber = yield* checkMuseProviderStatus(
        settings({ enabled: true }),
        undefined,
        undefined,
        async () => makeHost(metaCatalog),
        Effect.void,
        lastKnownVersion,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(DEFAULT_TIMEOUT_MS);
      const snapshot = yield* Fiber.join(fiber);
      expect({ status: snapshot.status, version: snapshot.version }).toEqual(expected);
      expect(snapshot.installed).toBe(true);
    }),
  );

  it.effect("tells the user to finish setup when the launcher has not installed its runtime", () =>
    Effect.gen(function* () {
      // What Muse's launcher prints when a fresh install runs under MUSE_NO_AUTO_UPDATE=1.
      const binaryPath = yield* fakeCli(
        'process.stderr.write("muse: installed binary is missing; rerun the installer\\n");process.exit(1);',
      );
      const snapshot = yield* checkMuseProviderStatus(settings({ enabled: true, binaryPath }));
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("muse --version");
    }),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          { ...process.env, META_API_KEY: "instance-key" },
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toBeUndefined();
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown", funding: "metered" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-wonder-1.0",
          "muse-custom",
        ]);
        expect(snapshot.models.map((model) => model.name)).toEqual([
          "Muse Wonder 1.0",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  // Muse falls back to its compiled-in catalog when the server rejects its login.
  it.effect.each([
    { source: "providerCatalog", live: true, age: 0, included: true },
    { source: "providerCatalog", live: true, age: 1, included: false },
    { source: "bundledCatalog", live: false, age: 0, included: false },
    { source: undefined, live: false, age: 0, included: false },
  ])(
    "reads a working login only from a model list the server sent (source $source)",
    ({ source, live, age, included }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* fakeCli();
          const now = Date.parse("2026-11-25T10:00:00Z");
          yield* TestClock.setTime(now);
          const usage = {
            tier: "pro",
            observedAtMs: now - age,
            window: { usedPercent: 120, windowDurationMins: 240, resetsAtMs: now + 3_600_000 },
            weekly: { usedPercent: 80, resetsAtMs: now + 86_400_000 },
          };
          let reportedLive = false;
          const snapshot = yield* checkMuseProviderStatus(
            settings({ enabled: true, binaryPath }),
            undefined,
            undefined,
            async () =>
              makeHost(source === undefined ? metaCatalog : { ...metaCatalog, source }, usage),
            Effect.sync(() => {
              reportedLive = true;
            }),
          );
          expect(reportedLive).toBe(live);
          expect(snapshot.usageLimits?.plan).toBe(included ? "pro" : undefined);
          expect(snapshot.usageLimits?.windows[0]?.windowDurationMins).toBe(
            included ? 240 : undefined,
          );
          expect(snapshot.auth.funding).toBe(included ? "included" : undefined);
          expect(snapshot.usageLimits?.windows.map((window) => window.usedPercent)).toEqual(
            included ? [100, 80] : undefined,
          );
        }),
      ),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.gen(function* () {
      const binaryPath = yield* fakeCli();
      const host = makeHost({ providerId: "meta", models: [] });
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath }),
        undefined,
        undefined,
        async () => host,
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models).toEqual([]);
      expect(host.close).toHaveBeenCalledOnce();
    }),
  );
});
