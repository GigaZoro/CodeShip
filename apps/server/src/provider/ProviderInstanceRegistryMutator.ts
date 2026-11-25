/** Reconcile closes removed/replaced scopes before creating replacements: at most one live instance per id. */
import type {
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  SecretReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * Each change runs to its end in the registry's scope: a caller that goes away stops waiting, but
 * cannot leave an instance retired and not rebuilt.
 */
export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
  /** Re-reads the secrets of every instance, or one, and rebuilds those whose secrets changed. */
  readonly reloadSecrets: (instanceId?: ProviderInstanceId) => Effect.Effect<void>;
  /**
   * Rebuilds the instances that read `reference` with `value`, keeping the other secrets a live
   * instance holds, and returns them. A parked instance reads its other secrets from the resolver.
   */
  readonly applySecret: (
    reference: SecretReference,
    value: string,
  ) => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  /** The reservation holds until a changed credential has been applied to its idle instance. */
  readonly refreshUnattendedSecrets: (
    reserve: (instanceId: ProviderInstanceId) => Effect.Effect<boolean, never, Scope.Scope>,
  ) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/ProviderInstanceRegistryMutator") {}
