import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { HttpServer, HttpServerError } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeNet from "node:net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import {
  hostHoldsProcessGroups,
  watchFreedGroupSignals,
} from "@t3tools/shared/testing/freedProcessGroups";
import { withoutWindowsTreeEnding } from "@t3tools/shared/windowsProcessTree";

import * as ServerConfig from "./config.ts";
import * as MigrationProgress from "./persistence/MigrationProgress.ts";
import { layerHttpServer, layerPlatformServices } from "./server.ts";

// Holds a port on a second loopback address, which Linux routes to loopback like all of
// 127.0.0.0/8, so a wildcard bind on that port fails with EADDRINUSE while 127.0.0.1 is free.
const occupyOtherLoopbackPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server & { readonly port: number }>((resume) => {
    const blocker = NodeNet.createServer();
    blocker.listen(0, "127.0.0.2", () => {
      const bound = blocker.address() as NodeNet.AddressInfo;
      resume(Effect.succeed(Object.assign(blocker, { port: bound.port })));
    });
  }),
  (blocker) => Effect.callback<void>((resume) => void blocker.close(() => resume(Effect.void))),
);

// macOS SO_REUSEADDR lets a wildcard bind share a port held on one address; Linux refuses it.
const wildcardBindConflicts = HostProcess.Platform.defaultValue() === "linux";

const httpServerWithConfig = (
  overrides: Pick<ServerConfig.ServerConfig["Service"], "host" | "port" | "privateNetworkOnly">,
) =>
  layerHttpServer.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, ...overrides })),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-bind-test-" })),
      ),
    ),
    Layer.provide(NetService.layer),
    Layer.provide(NodeServices.layer),
    Layer.provide(MigrationProgress.layer),
  );

it.live.skipIf(!wildcardBindConflicts)(
  "managed service falls back to loopback when its wildcard port is taken",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port } = yield* occupyOtherLoopbackPort;
        const { address, config } = yield* Effect.all({
          address: Effect.map(HttpServer.HttpServer, (server) => server.address),
          config: ServerConfig.ServerConfig,
        }).pipe(
          Effect.provide(httpServerWithConfig({ host: "0.0.0.0", port, privateNetworkOnly: true })),
        );
        assert.strictEqual(config.host, "127.0.0.1");
        const listening =
          address._tag === "InetAddressV4"
            ? `${String(address.address)}:${address.port}`
            : address._tag;
        assert.strictEqual(listening, `127.0.0.1:${port}`);
      }),
    ),
);

it.live.skipIf(!wildcardBindConflicts)(
  "an explicit wildcard host still fails when its port is taken",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port } = yield* occupyOtherLoopbackPort;
        const exit = yield* HttpServer.HttpServer.pipe(
          Effect.provide(
            httpServerWithConfig({ host: "0.0.0.0", port, privateNetworkOnly: undefined }),
          ),
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(exit));
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
        assert.instanceOf(error, HttpServerError.ServeError);
        assert.propertyVal(error.cause, "code", "EADDRINUSE");
      }),
    ),
);

// A spawner a later layer provides wins, so one over this would leave trees running on Windows.
it.effect("the server's spawner ends on Windows what a command left running", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    assert.notStrictEqual(withoutWindowsTreeEnding(spawner), spawner);
  }).pipe(
    Effect.provide(layerPlatformServices),
    Effect.provideService(HostProcess.Platform, "win32"),
  ),
);

// Likewise, one over this would signal emptied groups whose numbers may be another's since.
it.live.skipIf(
  HostProcess.Platform.defaultValue() === "win32" || !hostHoldsProcessGroups(process.env),
)("the server's spawner keeps a failed command's group number on macOS and Linux", () =>
  Effect.gen(function* () {
    const freed = yield* watchFreedGroupSignals;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    assert.strictEqual(yield* spawner.exitCode(ChildProcess.make("sh", ["-c", "exit 3"])), 3);
    assert.deepStrictEqual(freed.signals(), []);
  }).pipe(Effect.provide(layerPlatformServices), Effect.scoped),
);
