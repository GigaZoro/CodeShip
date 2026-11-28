import type { ServerSettingsError } from "@t3tools/contracts/settings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ProviderInstanceRegistrySyncShape {
  /**
   * Brings the registry up to the saved settings. Saves reach it in the background, so a write
   * runs this before it returns, and its caller can use the provider instances it saved. It fails
   * when the registry could not be brought up to them.
   */
  readonly catchUp: Effect.Effect<void, ServerSettingsError>;
}

export class ProviderInstanceRegistrySync extends Context.Service<
  ProviderInstanceRegistrySync,
  ProviderInstanceRegistrySyncShape
>()("t3/provider/ProviderInstanceRegistrySync") {}

/** For tests whose registry is a fixed set of instances, which always matches the settings. */
export const layerTest = Layer.succeed(ProviderInstanceRegistrySync, { catchUp: Effect.void });
