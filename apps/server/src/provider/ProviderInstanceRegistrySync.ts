import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistrySyncShape {
  /**
   * Brings the registry up to the saved settings. Saves reach it in the background, so a write
   * runs this before it returns, and its caller can use the provider instances it saved.
   */
  readonly catchUp: Effect.Effect<void>;
}

export class ProviderInstanceRegistrySync extends Context.Service<
  ProviderInstanceRegistrySync,
  ProviderInstanceRegistrySyncShape
>()("t3/provider/ProviderInstanceRegistrySync") {}
