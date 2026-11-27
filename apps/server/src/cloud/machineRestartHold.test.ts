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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
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
  drainResponse?: () => Response,
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
  const connected = yield* Deferred.make<void>();
  const fetch = yield* FetchHttpClient.Fetch;
  const countingFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.searchParams.get("drain") === "1") {
      drainLinks.opened += 1;
      if (drainResponse) {
        const response = drainResponse();
        Deferred.doneUnsafe(connected, Exit.void);
        return Promise.resolve(response);
      }
      init?.signal?.addEventListener("abort", () => (drainLinks.closed += 1), { once: true });
    }
    return fetch(input, init);
  };
  const localDrain = yield* SubscriptionRef.make({ holders: 0, admitting: 0 });
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
          Layer.succeed(UpdateDrain, localDrain),
        ),
      ),
    ),
  );
  const machine = Context.get(services, MachineRestartHold.MachineRestartHold);
  return { machine, secondaryHold, backend, drainLinks, localDrain, connected };
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

  it.effect("waits for the first drain line before running the body", () =>
    Effect.gen(function* () {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (value) => {
          controller = value;
        },
      });
      const { machine, connected } = yield* setup(
        idle,
        DESKTOP_TEST_SECRET,
        () => new Response(stream),
      );
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const body = yield* machine
        .whileDraining(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(connected);
      expect(yield* Deferred.isDone(entered)).toBe(false);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(idle) + "\n"));
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(body);
      expect(yield* Deferred.isDone(entered)).toBe(true);
    }),
  );

  it.effect("a dropped drain link fails the commit read until another first line arrives", () =>
    Effect.gen(function* () {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const response = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              value.enqueue(new TextEncoder().encode(JSON.stringify(answering) + "\n"));
            },
          }),
        );
      const { machine, connected } = yield* setup(idle, DESKTOP_TEST_SECRET, response);
      yield* machine.whileDraining(
        Effect.gen(function* () {
          yield* Deferred.await(connected);
          controller.close();
          yield* TestClock.adjust(1);
          expect(yield* Effect.flip(machine.restartHold)).toMatchObject({ backend: "WSL" });
          yield* TestClock.adjust("5 seconds");
          expect((yield* machine.restartHold).runningTurns).toEqual(answering.runningTurns);
        }),
      );
    }),
  );

  it.effect("immediately interrupting a background drain releases both holds", () =>
    Effect.gen(function* () {
      const { machine, backend, localDrain } = yield* setup(idle);
      yield* machine.whileDraining(
        Effect.gen(function* () {
          const child = yield* machine.drainInBackground(Effect.never);
          yield* Fiber.interrupt(child);
          expect((yield* SubscriptionRef.get(localDrain)).holders).toBe(1);
        }),
      );
      expect((yield* SubscriptionRef.get(localDrain)).holders).toBe(0);
      yield* SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter(({ holders }) => holders === 0),
        Stream.runHead,
      );
    }),
  );

  it.effect("bounds a silent drain acknowledgement and names the backend", () =>
    Effect.gen(function* () {
      const { machine, localDrain } = yield* setup(
        idle,
        DESKTOP_TEST_SECRET,
        () => new Response(new ReadableStream()),
      );
      const waiting = yield* Effect.forkChild(
        Effect.flip(machine.whileDraining(Effect.die("premature entry"))),
      );
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(waiting)).toMatchObject({ backend: "WSL" });
      expect((yield* SubscriptionRef.get(localDrain)).holders).toBe(0);
    }),
  );

  it.effect("bounds local drain acquisition and releases the holder on timeout", () =>
    Effect.gen(function* () {
      const { machine, localDrain } = yield* setup(idle);
      yield* SubscriptionRef.set(localDrain, { holders: 0, admitting: 1 });
      const waiting = yield* Effect.forkChild(
        Effect.flip(machine.whileDraining(Effect.die("premature entry"))),
      );
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(waiting)).toMatchObject({ backend: "primary" });
      expect(yield* SubscriptionRef.get(localDrain)).toEqual({ holders: 0, admitting: 1 });
    }),
  );

  it.effect("draining holds another backend's scheduled starts until the update ends", () =>
    Effect.gen(function* () {
      const { machine, backend } = yield* setup(idle);
      const heldThere = SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter(({ holders }) => holders === 1),
        Stream.runHead,
      );

      yield* machine.whileDraining(heldThere);

      const releasedThere = yield* SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter(({ holders }) => holders === 0),
        Stream.runHead,
      );
      expect(releasedThere._tag).toBe("Some");
    }),
  );

  it.effect("the drain a handoff keeps holds another backend on the same link, until it ends", () =>
    Effect.gen(function* () {
      const { machine, backend, drainLinks } = yield* setup(idle);
      const installerStops = yield* Deferred.make<void>();

      yield* machine.whileDraining(machine.drainInBackground(Deferred.await(installerStops)));
      yield* machine.restartHold;
      expect(drainLinks).toEqual({ opened: 1, closed: 0 });
      expect((yield* SubscriptionRef.get(backend.drain)).holders).toBe(1);

      yield* Deferred.succeed(installerStops, undefined);
      yield* SubscriptionRef.changes(backend.drain).pipe(
        Stream.filter(({ holders }) => holders === 0),
        Stream.runHead,
      );
      expect(drainLinks).toEqual({ opened: 1, closed: 1 });
    }),
  );

  it.effect("preserves draining: true when merging multi-backend restart holds", () =>
    Effect.gen(function* () {
      const { machine } = yield* setup({ ...answering, draining: true });
      const hold = yield* machine.restartHold;
      expect(hold.draining).toBe(true);
      expect(hold.runningTurns).toEqual(answering.runningTurns);
    }),
  );
});
