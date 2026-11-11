import { assert, describe, it } from "@effect/vitest";
import type { DesktopAutoInstallReadiness, DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type AutoInstallPorts, autoInstallTick } from "./DesktopAutoInstall.ts";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "1.0.0",
  channel: "latest",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const idle: DesktopAutoInstallReadiness = { enabled: true, idle: true };
const busy: DesktopAutoInstallReadiness = { enabled: true, idle: false };

/** Each read answers the next readiness in the list, then keeps answering the last. */
const run = (options: {
  readonly state?: Partial<DesktopUpdateState>;
  readonly window?: boolean;
  readonly readiness: ReadonlyArray<Option.Option<DesktopAutoInstallReadiness>>;
  readonly ticks?: number;
}) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const reads = yield* Ref.make(0);
    const ports: AutoInstallPorts = {
      hasWindow: Effect.succeed(options.window === true),
      getState: Effect.succeed({ ...baseState, ...options.state }),
      readReadiness: Ref.getAndUpdate(reads, (n) => n + 1).pipe(
        Effect.map((n) => options.readiness[Math.min(n, options.readiness.length - 1)]!),
      ),
      download: Effect.sync(() => void calls.push("download")),
      install: (version) => Effect.sync(() => void calls.push(`install ${version}`)),
    };
    const attempts = yield* Ref.make({ download: null, install: null } as {
      download: string | null;
      install: string | null;
    });
    for (let i = 0; i < (options.ticks ?? 1); i += 1) yield* autoInstallTick(ports, attempts);
    return calls;
  });

describe("automatic install with every window closed", () => {
  it.effect("installs a downloaded update once the app is idle", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run({ readiness: [Option.some(idle)] }), ["install 1.1.0"]);
    }),
  );

  it.effect("downloads a found update first", () =>
    Effect.gen(function* () {
      const calls = yield* run({
        state: { status: "available", downloadedVersion: null },
        readiness: [Option.some(idle)],
      });
      assert.deepStrictEqual(calls, ["download"]);
    }),
  );

  it.effect("waits while a chat is answering or background work runs, then installs", () =>
    Effect.gen(function* () {
      const calls = yield* run({
        readiness: [Option.some(busy), Option.some(busy), Option.some(idle)],
        ticks: 3,
      });
      assert.deepStrictEqual(calls, ["install 1.1.0"]);
    }),
  );

  it.effect("puts the install off when a chat starts between the look and the install", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run({ readiness: [Option.some(idle), Option.some(busy)] }), []);
    }),
  );

  it.effect("does nothing when the server cannot be asked", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run({ readiness: [Option.none()] }), []);
    }),
  );

  it.effect("does nothing with the setting off", () =>
    Effect.gen(function* () {
      const off = Option.some({ enabled: false, idle: true });
      assert.deepStrictEqual(yield* run({ readiness: [off] }), []);
    }),
  );

  it.effect("leaves the decision to an open window", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run({ window: true, readiness: [Option.some(idle)] }), []);
    }),
  );

  it.effect("does nothing when there is no update", () =>
    Effect.gen(function* () {
      const calls = yield* run({
        state: { status: "idle", availableVersion: null, downloadedVersion: null },
        readiness: [Option.some(idle)],
      });
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("never retries a version it already tried", () =>
    Effect.gen(function* () {
      const calls = yield* run({ readiness: [Option.some(idle)], ticks: 3 });
      assert.deepStrictEqual(calls, ["install 1.1.0"]);
    }),
  );
});
