// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the desktop's fds.
/** Playwright needs a CDP WebSocket; the secret loopback endpoint relays desktop debugger frames over bootstrap fds. */
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
  type PreviewAutomationLoadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

/** `declined`: no desktop window can show the tab. `timedOut`: a window can, but did not in time. */
export type DesktopAttachOutcome = "attached" | "declined" | "timedOut";

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    /**
     * The desktop app started this server, so its window may render server tabs natively.
     * It stays true after the event pipe closes: the window can still be connected then.
     */
    readonly available: boolean;
    /**
     * While it waits, the desktop keeps the window that mounts the tab rendering. Once the
     * event pipe closes, no tab can attach, and every wait is declined.
     */
    readonly awaitAttached: (
      key: DesktopTabKey,
      timeout: Duration.Input,
    ) => Effect.Effect<DesktopAttachOutcome>;
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly attached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    /** Whether a desktop window draws the tab on screen, which no streamed viewer counts. */
    readonly isShown: (key: DesktopTabKey) => boolean;
    /** Resolves true once the tab is shown, or false on timeout. */
    readonly awaitShown: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    /** A load failure the desktop saw, possibly before the server connected to the tab. */
    readonly loadFailure: (key: DesktopTabKey) => PreviewAutomationLoadError | undefined;
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
    /** Never fails. A failed write means a broken channel; the next backend starts with no turns. */
    readonly turn: (threadId: string, active: boolean) => Effect.Effect<void>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

/** The two bootstrap fds, as the channel uses them. */
export interface DesktopBrowserPipes {
  /** NDJSON `DesktopBrowserEvent` bytes. It ends when the desktop closes its end. */
  readonly events: Stream.Stream<Uint8Array, Error>;
  /** Writes one newline-terminated `DesktopBrowserCommand` line. */
  readonly write: (line: string) => Effect.Effect<void, Error>;
}

const noDesktop = DesktopBrowserChannel.of({
  available: false,
  awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function () {
    return Effect.succeed("declined" as const);
  }),
  detached: Stream.empty,
  attached: Stream.empty,
  isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function () {
    return Effect.succeed(false);
  }),
  endpoint: Effect.fn("DesktopBrowserChannel.endpoint")(function () {
    return Effect.die("No desktop app is attached to this server.");
  }),
  turn: Effect.fn("DesktopBrowserChannel.turn")(function () {
    return Effect.void;
  }),
  pointer: Effect.fn("DesktopBrowserChannel.pointer")(function () {
    return Effect.void;
  }),
  isShown: () => false,
  awaitShown: Effect.fn("DesktopBrowserChannel.awaitShown")(function () {
    return Effect.succeed(false);
  }),
  loadFailure: () => undefined,
});

const makeConnected = Effect.fn("DesktopBrowserChannel.makeConnected")(function* (
  pipes: DesktopBrowserPipes,
) {
  const channelScope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<{
    key: DesktopTabKey;
    change: "attached" | "detached" | "declined";
  }>();
  const attachedTabs = new Map<string, DesktopTabKey>();
  // Missing reports protect desktop tabs until the renderer explicitly marks them hidden.
  const shownTabs = new Map<string, boolean>();
  const shownReports = yield* PubSub.unbounded<string>();
  const loadFailures = new Map<string, PreviewAutomationLoadError>();
  const inbound = new Map<string, Queue.Queue<string>>();
  const writeLock = yield* Semaphore.make(1);
  const closed = yield* Deferred.make<void>();

  const command = (message: DesktopBrowserCommandType) =>
    writeLock.withPermits(1)(
      encodeCommand(message).pipe(
        Effect.flatMap((line) => pipes.write(`${line}\n`)),
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop browser command failed", { cause }),
        ),
      ),
    );

  const detach = (id: string, key: DesktopTabKey) => {
    attachedTabs.delete(id);
    shownTabs.delete(id);
    loadFailures.delete(id);
    const queue = inbound.get(id);
    return (queue ? Queue.shutdown(queue) : Effect.void).pipe(
      Effect.andThen(PubSub.publish(changes, { key, change: "detached" as const })),
    );
  };

  // With the pipe gone no tab can attach or keep relaying, so the server runs them headless.
  const close = Effect.gen(function* () {
    for (const [id, key] of attachedTabs) yield* detach(id, key);
    shownTabs.clear();
    loadFailures.clear();
    yield* Deferred.succeed(closed, undefined);
    yield* Effect.logWarning("desktop browser channel closed; agent tabs now run headless");
  });

  yield* pipes.events.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
    Stream.runForEach((decoded) => {
      if (Option.isNone(decoded)) return Effect.void;
      const event = decoded.value;
      const key = { threadId: event.threadId, tabId: event.tabId };
      const id = keyOf(key);
      switch (event.type) {
        case "cdp": {
          const queue = inbound.get(id);
          return queue ? Queue.offer(queue, event.message).pipe(Effect.asVoid) : Effect.void;
        }
        case "attached":
          attachedTabs.set(id, key);
          return PubSub.publish(changes, { key, change: event.type });
        case "loadFailed":
          loadFailures.set(id, {
            url: event.url.slice(0, 2048),
            code: event.code,
            description: event.description,
          });
          return Effect.void;
        case "detached":
          return detach(id, key);
        case "shown":
          shownTabs.set(id, event.shown);
          return event.shown ? PubSub.publish(shownReports, id) : Effect.void;
        case "declined":
          return PubSub.publish(changes, { key, change: event.type });
      }
    }),
    Effect.catchCause((cause) => Effect.logWarning("desktop browser channel stopped", { cause })),
    Effect.andThen(close),
    Effect.forkScoped,
  );

  // The desktop keeps the tab's window rendering between these writes. They run on the channel's
  // scope so a slow pipe never holds up the waiter, and in one fiber so `false` cannot overtake `true`.
  const holdRendering = Effect.fn("DesktopBrowserChannel.holdRendering")(function* (
    key: DesktopTabKey,
  ) {
    const released = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
    yield* command({ type: "awaiting", ...key, active: true }).pipe(
      Effect.andThen(Deferred.await(released)),
      Effect.andThen(command({ type: "awaiting", ...key, active: false })),
      Effect.forkIn(channelScope),
    );
  });

  const endpoint = Effect.fn("DesktopBrowserChannel.endpoint")(function* (key: DesktopTabKey) {
    const id = keyOf(key);
    const secret = NodeCrypto.randomBytes(24).toString("base64url");
    const server = yield* NodeSocketServer.makeWebSocket({
      host: "127.0.0.1",
      port: 0,
      path: `/${secret}`,
    }).pipe(Effect.orDie);
    const queue = yield* Queue.unbounded<string>();
    inbound.set(id, queue);
    // A detach before this registration shut down no queue, so check again.
    if (!attachedTabs.has(id)) {
      inbound.delete(id);
      return yield* Effect.die("The desktop tab detached before the server connected.");
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (inbound.get(id) === queue) inbound.delete(id);
        yield* Queue.shutdown(queue);
        yield* command({ type: "release", ...key });
      }),
    );
    // The relay serves one Playwright connection; a second would see the first's sessions.
    let connected = false;
    yield* server
      .run((socket) =>
        Effect.gen(function* () {
          if (connected) return;
          connected = true;
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          // A detach shuts the queue down. Ending here closes the socket, so Playwright's
          // pending commands fail instead of waiting forever for the tab to answer.
          const toPlaywright = Stream.fromQueue(queue).pipe(
            Stream.runForEach((message) => writer.write(message)),
            Effect.exit,
          );
          const decoder = new TextDecoder();
          const toDesktop = reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) =>
                  command({
                    type: "cdp",
                    ...key,
                    message: typeof frame === "string" ? frame : decoder.decode(frame),
                  }),
                { discard: true },
              ),
            ),
            Effect.forever,
          );
          return yield* Effect.raceFirst(toPlaywright, toDesktop);
        }).pipe(Effect.scoped, Effect.ignore),
      )
      .pipe(Effect.forkScoped);
    const address = server.address;
    if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
    return `ws://127.0.0.1:${address.port}/${secret}`;
  });

  const isShown = (key: DesktopTabKey) => shownTabs.get(keyOf(key)) ?? true;

  return DesktopBrowserChannel.of({
    available: true,
    awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function (key, timeout) {
      const id = keyOf(key);
      return Effect.gen(function* () {
        // Subscribe before checking so a concurrent attach cannot be missed.
        const subscription = yield* PubSub.subscribe(changes);
        if (attachedTabs.has(id)) return "attached" as const;
        if (yield* Deferred.isDone(closed)) return "declined" as const;
        yield* holdRendering(key);
        return yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter((change) => change.change !== "detached" && keyOf(change.key) === id),
          Stream.runHead,
          Effect.map((found) =>
            Option.isSome(found) && found.value.change === "attached"
              ? ("attached" as const)
              : ("declined" as const),
          ),
          Effect.raceFirst(Deferred.await(closed).pipe(Effect.as("declined" as const))),
        );
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(timeout),
        Effect.map(Option.getOrElse(() => "timedOut" as const)),
      );
    }),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.change === "detached"),
      Stream.map((change) => change.key),
    ),
    attached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.change === "attached"),
      Stream.map((change) => change.key),
    ),
    isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function (key) {
      return Effect.sync(() => attachedTabs.has(keyOf(key)));
    }),
    isShown,
    awaitShown: Effect.fn("DesktopBrowserChannel.awaitShown")(function (key, timeout) {
      return Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(shownReports);
          if (isShown(key)) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((id) => id === keyOf(key)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      );
    }),
    loadFailure: (key) => loadFailures.get(keyOf(key)),
    endpoint,
    turn: Effect.fn("DesktopBrowserChannel.turn")(function (threadId, active) {
      return command({ type: "turn", threadId, active });
    }),
    pointer: Effect.fn("DesktopBrowserChannel.pointer")(function (key, pointer) {
      return command({ type: "pointer", ...key, ...pointer });
    }),
  });
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  if (inputFd === undefined || controlFd === undefined) return noDesktop;

  // Use cancellable socket reads; filesystem pipe reads keep Node alive after scope shutdown.
  const readable = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeNet.Socket({ fd: inputFd, readable: true, writable: false })),
    (stream) => Effect.sync(() => stream.destroy()),
  );
  return yield* makeConnected({
    events: NodeStream.fromReadable<Uint8Array, Error>({
      evaluate: () => readable,
      closeOnDone: true,
      onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
    write: (line) => writeAllToFileDescriptor(controlFd, Buffer.from(line)),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);

export const layerFromPipes = (pipes: DesktopBrowserPipes) =>
  Layer.effect(DesktopBrowserChannel, makeConnected(pipes));
