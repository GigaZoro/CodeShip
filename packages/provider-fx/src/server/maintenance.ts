import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { FX_DRIVER_KIND } from "./acpSupport.ts";
import { runFxCli } from "./status.ts";

const STABLE_VERSION_URL = "https://releases.fx.sh/latest.txt";
const VERSION_TIMEOUT = "4 seconds";
const decodeFxUpdateChannels = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      update_channel: Schema.Literals(["stable", "dev"]),
      build_channel: Schema.optionalKey(Schema.Literals(["stable", "dev"])),
    }),
  ),
);

export const manualFxMaintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: FX_DRIVER_KIND,
  packageName: null,
});

export function makeFxMaintenanceResolver(
  http: HttpClient.HttpClient,
): ProviderMaintenanceCapabilitiesResolver {
  const lookupLatestVersion = http.execute(HttpClientRequest.get(STABLE_VERSION_URL)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) =>
      collectUint8StreamText({ stream: response.stream, maxBytes: 128 }),
    ),
    Effect.map((body) =>
      body.truncated || body.invalidUtf8
        ? null
        : (/^v?(\d+\.\d+\.\d+)$/u.exec(body.text.trim())?.[1] ?? null),
    ),
    Effect.timeout(VERSION_TIMEOUT),
    Effect.catch((error) =>
      Effect.logWarning("Could not read the fx stable release version", {
        errorTag: error._tag,
      }).pipe(Effect.as(null)),
    ),
  );
  return {
    resolve: Effect.fn("FxMaintenance.resolve")(function* (context) {
      if (!context || (context.platform !== "darwin" && context.platform !== "linux")) {
        return manualFxMaintenance;
      }
      const path = yield* Path.Path;
      const home = context.env.HOME?.trim() || (yield* HostProcess.HomeDirectory);
      const directory = context.env.FX_INSTALL_DIR?.trim() || path.join(home, ".local", "bin");
      const installedPath = path.resolve(directory, "fx");
      const manual = { ...manualFxMaintenance, installPath: context.realCommandPath };
      // The native updater replaces its own binary in place, including a shim's target.
      if (
        context.resolvedCommandPath !== installedPath ||
        context.realCommandPath !== installedPath
      ) {
        return manual;
      }
      const channels = yield* runFxCli(
        { binaryPath: installedPath },
        ["status", "--json"],
        context.env,
      ).pipe(
        Effect.map((result) =>
          result.code === 0 ? decodeFxUpdateChannels(result.stdout) : Option.none(),
        ),
        Effect.timeout(VERSION_TIMEOUT),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (
        Option.isNone(channels) ||
        channels.value.update_channel !== "stable" ||
        channels.value.build_channel === "dev"
      ) {
        return manual;
      }
      return makeProviderMaintenanceCapabilities({
        provider: FX_DRIVER_KIND,
        packageName: null,
        updateExecutable: installedPath,
        updateArgs: ["upgrade"],
        updateLockKey: `fx-native:${installedPath}`,
        platform: context.platform,
        env: context.env,
        lookupLatestVersion,
      });
    }),
  };
}
