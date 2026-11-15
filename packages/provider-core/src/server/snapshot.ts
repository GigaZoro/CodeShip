import type {
  ProviderUsageLimitsUpdate,
  ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "./maintenance.ts";

export interface ManagedServerProvider {
  /** Cached; pass { fresh: true } before executing updates. */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly refreshUsage?: Effect.Effect<void, ServerSettingsError>;
  /**
   * Reads the account again after a reset was used, withdrawing the reset fields read before it
   * even if the read fails. The read outlives a caller that stops waiting; the fiber succeeds
   * with whether fresh usage confirmed the change.
   */
  readonly refreshAfterRedemption: Effect.Effect<Fiber.Fiber<boolean>>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Merge windows by ID; updates with no usable window leave the snapshot untouched. */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
}
