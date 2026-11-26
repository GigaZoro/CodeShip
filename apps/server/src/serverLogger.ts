import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SharedObservability from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as OtlpLogger from "effect/observability/OtlpLogger";

import * as ServerConfig from "./config.ts";
import * as OtlpExportFailures from "./observability/OtlpExportFailures.ts";

export const layer = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const hostName = yield* HostProcess.Hostname;
  const layerMinimumLogLevel = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  const logs = config.otlpLogsExport;
  const otlpLogger =
    config.otlpLogsUrl === undefined
      ? undefined
      : OtlpLogger.make({
          url: config.otlpLogsUrl,
          exportInterval: `${logs.exportIntervalMs} millis`,
          headers: logs.headers,
          resource: ServerConfig.otlpResource(config, hostName),
        }).pipe(Effect.provide(SharedObservability.layerOtlpSerialization(logs.protocol)));

  return Layer.mergeAll(
    SharedObservability.layerRedactedLoggers(otlpLogger, logs.protocol).pipe(
      Layer.provide(OtlpExportFailures.layer("logs")),
    ),
    layerMinimumLogLevel,
  ).pipe(Layer.provide(SharedObservability.layerOtlpSerialization(logs.protocol)));
}).pipe(Layer.unwrap);
