import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type { DesktopBackendEndpoint, OrchestrationV2RestartHold } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as ServerConfig from "../config.ts";
import { layerDesktopRestartHoldRoute } from "../http.ts";
import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as MachineRestartHold from "./machineRestartHold.ts";
import { UpdateDrain } from "./updateDrain.ts";

export const DESKTOP_TEST_SECRET = "desktop-test-secret";

/**
 * Another desktop backend, serving its restart hold over a real local HTTP server the way the
 * primary reaches it. `drain` counts the drains held on it.
 */
export const serveDesktopBackend = Effect.fn("test.serve_desktop_backend")(function* (
  hold: SubscriptionRef.SubscriptionRef<OrchestrationV2RestartHold>,
  baseDir: string,
) {
  const drain = yield* SubscriptionRef.make(0);
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
  );
  const backendConfig = ServerConfig.layer({
    ...config,
    mode: "desktop",
    desktopBootstrapSecret: DESKTOP_TEST_SECRET,
  });
  const services = yield* Layer.build(
    HttpRouter.serve(layerDesktopRestartHoldRoute, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(
        Layer.effect(MachineRestartHold.MachineRestartHold, MachineRestartHold.make()).pipe(
          Layer.provide(
            Layer.mergeAll(
              backendConfig,
              Layer.mock(ProviderRuntimeRecoveryService)({
                restartHold: SubscriptionRef.get(hold),
                watchRestartHold: SubscriptionRef.changes(hold),
              }),
              DesktopTelemetryReceiver.layerTest(),
              FetchHttpClient.layer,
              Layer.succeed(UpdateDrain, drain),
            ),
          ),
        ),
      ),
      Layer.provide(backendConfig),
    ),
  );
  const endpoint: DesktopBackendEndpoint = {
    id: "wsl",
    label: "WSL",
    httpBaseUrl: HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address),
  };
  return { endpoint, drain };
});
