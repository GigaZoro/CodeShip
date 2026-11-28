import type { ServerProviderUpdateError } from "@t3tools/contracts/provider";
import type { ProviderDriverKind } from "@t3tools/contracts/providerInstance";
import type * as Effect from "effect/Effect";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /** Opaque identity of the resolved CLI installation. */
  readonly updateKey?: string;
  readonly builtInUpdate?: {
    readonly lockKey: string;
    readonly run: (version: string) => Effect.Effect<void, ServerProviderUpdateError>;
  };
  /** undefined defers to npm; null means the installer could not determine the latest version. */
  readonly latestVersion?: string | null;
  /**
   * Deferred until update checks are enabled; `null` falls back to
   * `latestVersion`, then npm.
   */
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  readonly compareVersions?: (current: string, latest: string) => number;
  /** Resolved executable path for advisories when no update command is proven. */
  readonly installPath?: string;
  /** Displayed for manual updates; never executed by T3.CodeShip. */
  readonly manualCommand?: string;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** The provider's environment, including its PATH and custom home. */
  readonly env?: NodeJS.ProcessEnv;
}
