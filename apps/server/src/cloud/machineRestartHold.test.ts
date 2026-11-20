import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type DesktopBackendEndpoint,
  type OrchestrationV2RestartHold,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as MachineRestartHold from "./machineRestartHold.ts";
import { DESKTOP_TEST_SECRET, serveDesktopBackend } from "./machineRestartHold.testkit.ts";
import { UpdateDrain } from "./updateDrain.ts";

const idle: OrchestrationV2RestartHold = { work: [], runningTurns: [] };
const answering: OrchestrationV2RestartHold = {
  work: [],
  runningTurns: [{ threadId: ThreadId.make("wsl-thread"), threadTitle: "Runs in WSL" }],
};

/** A primary over its own idle hold, with a WSL backend serving `secondary` listed beside it. */
const setup = Effect.fn("test.setup_machine_restart_hold")(function* (
  secondary: OrchestrationV2RestartHold,
  primarySecret: string = DESKTOP_TEST_SECRET,
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped();
  const secondaryHold = yield* SubscriptionRef.make(secondary);
  const backend = yield* serveDesktopBackend(secondaryHold, baseDir);
  const primaryHold = yield* SubscriptionRef.make(idle);
  const backends = yield* SubscriptionRef.make<ReadonlyArray<DesktopBackendEndpoint>>([
    backend.endpoint,
  ]);
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
  );
  /** The drain links the primary opened to the other backend, and how many it has closed. */
  const drainLinks = { opened: 0, closed: 0 };
  const fetch = yield* FetchHttpClient.Fetch;
  const countingFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.searchParams.get("drain") === "1") {
      drainLinks.opened += 1;
      init?.signal?.addEventListener("abort", () => (drainLinks.closed += 1), { once: true });
    }
    return fetch(input, init);
  };
  // Built in the test's scope, so its drain links live as long as the test.
  const services = yield* Layer.build(
    Layer.effect(MachineRestartHold.MachineRestartHold, MachineRestartHold.make()).pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layer({
            ...config,
            mode: "desktop",
            desktopBootstrapSecret: primarySecret,
          }),
          Layer.mock(ProviderRuntimeRecoveryService)({
            restartHold: SubscriptionRef.get(primaryHold),
            watchRestartHold: SubscriptionRef.changes(primaryHold),
          }),
          DesktopTelemetryReceiver.layerTest({
            desktopBackends: SubscriptionRef.changes(backends),
          }),
          FetchHttpClient.layer,
          Layer.succeed(FetchHttpClient.Fetch, countingFetch),
          Layer.succeed(UpdateDrain, yield* SubscriptionRef.make(0)),
        ),
      ),
    ),
  );
  const machine = Context.get(services, MachineRestartHold.MachineRestartHold);
  return { machine, secondaryHold, backend, drainLinks };
});

it.layer(NodeServices.layer)("machine restart hold", (it) => {
  it.effect("an idle primary holds while another backend runs a turn, until that one is idle", () =>
    Effect.gen(function* () {
      const { machine, secondaryHold } = yield* setup(answering);
      const seen = yield* Deferred.make<void>();
      const holds = yield* machine.watchRestartHold.pipe(
        Stream.tap(() => Deferred.succeed(seen, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(seen);
      yield* SubscriptionRef.set(secondaryHold, idle);

      expect(yield* Fiber.join(holds)).toEqual([
        { work: [], runningTurns: answering.runningTurns, commands: [] },
        { work: [], runningTurns: [], commands: [] },
      ]);
    }),
  );

  it.effect("a backend whose hold cannot be read fails the hold, naming that backend", () =>
    Effect.gen(function* () {
      const { machine } = yield* setup(idle, "another-secret");

      const error = yield* Effect.flip(machine.restartHold);

      expect(error).toMatchObject({ _tag: "BackendRestartHoldError", backend: "WSL" });
    }),
  );

  it.effect("draining holds another backend's scheduled starts until the update ends", () =>
    Effect.gen(function* () {
      const { machine, backend } = yield* setup(idle);
      const heldThere = SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter((holders) => holders === 1),
        Stream.runHead,
      );

      yield* machine.whileDraining(heldThere);

      const releasedThere = yield* SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter((holders) => holders === 0),
        Stream.runHead,
      );
      expect(releasedThere._tag).toBe("Some");
    }),
  );

  it.effect("the drain a handoff keeps holds another backend on the same link, until it ends", () =>
    Effect.gen(function* () {
      const { machine, backend, drainLinks } = yield* setup(idle);
      const heldThere = SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter((holders) => holders === 1),
        Stream.runHead,
      );
      const installerStops = yield* Deferred.make<void>();

      yield* machine.whileDraining(
        heldThere.pipe(Effect.andThen(machine.drainInBackground(Deferred.await(installerStops)))),
      );
      // A round trip to the other backend, so a link the ended drain let go would be closed by now.
      yield* machine.restartHold;
      expect(drainLinks).toEqual({ opened: 1, closed: 0 });
      expect(yield* SubscriptionRef.get(backend.drain)).toBe(1);

      yield* Deferred.succeed(installerStops, undefined);
      yield* SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter((holders) => holders === 0),
        Stream.runHead,
      );
      expect(drainLinks).toEqual({ opened: 1, closed: 1 });
    }),
  );
});
