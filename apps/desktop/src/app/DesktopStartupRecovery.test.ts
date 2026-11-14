import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";

import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { listen, resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer version before going back", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
        null,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check before offering to go back", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "checking" }), "0.1.2")).toEqual({
      _tag: "Checking",
    });
  });

  it("offers the last version that started when no update exists", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2")).toEqual({
      _tag: "Reinstall",
      version: "0.1.2",
    });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2" });
  });

  it("falls back to the releases page when this version never started", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.3")).toEqual({
      _tag: "Releases",
    });
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), null)).toEqual({
      _tag: "Releases",
    });
  });
});

const failing = {
  _tag: "Failing",
  reason: "Server failed before readiness",
  output: "Failure details",
} as const;

const startRecovery = Effect.fn("test.startRecovery")(function* (options: {
  readonly visible: boolean;
  readonly started: boolean;
}) {
  const checked = yield* Deferred.make<void>();
  const remembered = yield* Deferred.make<void>();
  const closed = Promise.withResolvers<void>();
  const loads = yield* Queue.unbounded<string>();
  const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const mainListeners = new Map<string, () => void>();
  const counts = { close: 0 };
  let mainVisible = options.visible;
  const main = {
    isDestroyed: () => false,
    isVisible: () => mainVisible,
    on: (event: string, listener: () => void) => mainListeners.set(event, listener),
    once: (event: string, listener: () => void) => mainListeners.set(event, listener),
  } as unknown as Electron.BrowserWindow;
  const mainRef = yield* Ref.make(Option.some(main));
  const recovery = {
    isDestroyed: () => false,
    close: () => {
      counts.close++;
      closed.resolve();
    },
    loadURL: (url: string) => {
      Queue.offerUnsafe(loads, decodeURIComponent(url));
      return Promise.resolve();
    },
    once: () => {},
    webContents: { setWindowOpenHandler: () => {}, on: () => {} },
  } as unknown as Electron.BrowserWindow;
  const { primaryBackendStartup: startup } = yield* DesktopState.DesktopState;
  if (options.started) yield* SubscriptionRef.set(startup, { _tag: "Ready" });
  yield* listen.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed("0.1.2"),
          writeFileString: () => Deferred.succeed(remembered, undefined).pipe(Effect.asVoid),
        }),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          appVersion: "0.1.3",
          stateDir: "/task/state",
          logDir: "/task/logs",
          path: { join: (...parts: string[]) => parts.join("/") },
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.succeed(ElectronApp.ElectronApp, {
          on: (event: string, listener: (...args: readonly unknown[]) => void) =>
            Effect.sync(() => {
              appListeners.set(event, listener);
            }),
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Layer.succeed(ElectronShell.ElectronShell, {} as ElectronShell.ElectronShell["Service"]),
        Layer.succeed(ElectronTheme.ElectronTheme, {
          shouldUseDarkColors: Effect.succeed(false),
        } as ElectronTheme.ElectronTheme["Service"]),
        Layer.succeed(ElectronWindow.ElectronWindow, {
          main: Ref.get(mainRef),
          create: () => Effect.succeed(recovery),
          reveal: () => Effect.void,
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
        Layer.succeed(DesktopUpdates.DesktopUpdates, {
          subscribe: Effect.succeed({
            latest: updateState({ status: "disabled" }),
            changes: Stream.empty,
          }),
          check: () => Deferred.succeed(checked, undefined),
        } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
      ),
    ),
  );
  const mainCreated = () => appListeners.get("browser-window-created")?.({}, main);
  mainCreated();
  return {
    startup,
    checked,
    remembered,
    closed: closed.promise,
    loads,
    main,
    mainRef,
    mainListeners,
    mainCreated,
    closeCount: () => counts.close,
    setMainVisible: (visible: boolean) => {
      mainVisible = visible;
    },
  };
});

it.effect.each([
  { visible: false, started: false, closeMain: false },
  { visible: true, started: false, closeMain: false },
  { visible: true, started: true, closeMain: false },
  { visible: true, started: false, closeMain: true },
])("closes recovery safely with closeMain=$closeMain", ({ visible, started, closeMain }) =>
  Effect.gen(function* () {
    const recovery = yield* startRecovery({ visible, started });
    const shouldRecover = !visible || !started;
    if (started) yield* Deferred.await(recovery.remembered);
    yield* SubscriptionRef.set(recovery.startup, failing);
    yield* Deferred.await(recovery.checked);
    expect(yield* Queue.size(recovery.loads)).toBe(shouldRecover ? 1 : 0);
    if (shouldRecover) {
      expect(yield* Queue.take(recovery.loads)).toContain("Failure details");
      if (closeMain) yield* Ref.set(recovery.mainRef, Option.none());
      yield* SubscriptionRef.set(recovery.startup, { _tag: "Ready" });
      yield* Deferred.await(recovery.remembered);
      if (closeMain || !visible) {
        expect(recovery.closeCount()).toBe(0);
        if (closeMain) {
          yield* Ref.set(recovery.mainRef, Option.some(recovery.main));
          recovery.setMainVisible(false);
          recovery.mainCreated();
        }
        recovery.mainListeners.get("ready-to-show")?.();
        expect(recovery.closeCount()).toBe(0);
        recovery.setMainVisible(true);
        const show = recovery.mainListeners.get("show");
        expect(show).toBeDefined();
        show!();
      }
      yield* Effect.promise(() => recovery.closed);
      expect(recovery.closeCount()).toBe(1);
    }
  }).pipe(Effect.scoped, Effect.provide(DesktopState.layer)),
);

it.effect("shows migration progress instead of a failure, and the failure if one follows", () =>
  Effect.gen(function* () {
    const recovery = yield* startRecovery({ visible: false, started: false });
    const migrating = (progress: number) =>
      SubscriptionRef.set(recovery.startup, {
        _tag: "Migrating",
        migration: "91_CompactOrchestrationIds",
        progress,
      });

    yield* migrating(0.25);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.size(recovery.loads)).toBe(0);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(recovery.loads)).toContain("25% done");

    yield* migrating(0.5);
    expect(yield* Queue.take(recovery.loads)).toContain("50% done");
    expect(yield* Deferred.isDone(recovery.checked)).toBe(false);

    yield* SubscriptionRef.set(recovery.startup, failing);
    expect(yield* Queue.take(recovery.loads)).toContain("Failure details");
    yield* Deferred.await(recovery.checked);

    yield* SubscriptionRef.set(recovery.startup, { _tag: "Ready" });
    yield* Deferred.await(recovery.remembered);
    recovery.setMainVisible(true);
    recovery.mainListeners.get("show")?.();
    yield* Effect.promise(() => recovery.closed);
  }).pipe(Effect.scoped, Effect.provide(DesktopState.layer)),
);
