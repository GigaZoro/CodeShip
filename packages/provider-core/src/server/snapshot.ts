import type {
  ProviderUsageLimitsUpdate,
  ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "./maintenance.ts";

/** authLabel names the plan, for drivers whose usage report carries it. */
export type ProviderUsageLimitsReport = ProviderUsageLimitsUpdate & {
  readonly checkedAt: string;
  readonly authLabel?: string;
  /** A full reading replaces sparse windows and clears a previous probe failure. */
  readonly complete?: boolean;
};

export type UsageLimitsPublisher = (update: ProviderUsageLimitsReport) => Effect.Effect<void>;

export interface ManagedServerProvider {
  /** Cached; pass { fresh: true } before executing updates. */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /** True while getSnapshot still returns the placeholder from before the first completed check. */
  readonly isAwaitingFirstCheck?: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly refreshUsage?: Effect.Effect<void, ServerSettingsError>;
  /**
   * Reads the account again after a reset was used, withdrawing the reset fields read before it
   * even if the read fails. The read outlives a caller that stops waiting; the fiber succeeds
   * with whether fresh usage confirmed the change.
   */
  readonly refreshAfterRedemption: Effect.Effect<Fiber.Fiber<boolean>>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Capture once when the native session opens. Its updates stop when the account changes. */
  readonly bindUsageLimits: Effect.Effect<UsageLimitsPublisher>;
}
