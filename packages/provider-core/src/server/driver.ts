// Context tags are runtime singletons; drivers need multiple instances.
import type {
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  AcpRegistrySetProviderInput,
} from "@t3tools/contracts/acpRegistry";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import type {
  ProviderDriverKind,
  ResolvedProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts/providerInstance";
import type {
  ProviderMcpError,
  ProviderMcpServer,
  ProviderMcpServerConfig,
} from "@t3tools/contracts/providerMcp";
import type {
  ProviderPlugin,
  ProviderPluginAddMarketplaceResult,
  ProviderPluginError,
  ProviderPluginInstallResult,
  ProviderPluginMarketplace,
} from "@t3tools/contracts/providerPlugins";
import type { ProviderSkillError } from "@t3tools/contracts/providerSkills";
import type {
  ProviderConsumeResetCreditResult,
  ServerProviderResetKind,
} from "@t3tools/contracts/providerUsageLimits";
import type { ServerProvider, ServerProviderWorkspaceSnapshot } from "@t3tools/contracts/server";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAuthController } from "./auth.ts";
import type { ProviderDriverError } from "./errors.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { ProviderUsageReader } from "./usage.ts";

export interface ProviderDriverMetadata {
  readonly displayName: string;
  /** Defaults to true; false rejects multiple instances of a global resource. */
  readonly supportsMultipleInstances?: boolean;
  readonly hasDefaultInstance?: boolean;
  /**
   * Set only where `create` gives an added (non-default) instance its own login on each machine
   * without any setting, so an account shared from another machine never runs on this one's
   * default login. Shared settings share accounts of these drivers alone.
   */
  readonly privateAccountHomes?: boolean;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending" | "optionDescriptors">;

/** The folder a provider keeps its login in; `secret` when it came from a secret, so it is never written out. */
export type ProviderConfigFolder =
  | { readonly kind: "default" }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "secret" };

export interface ProviderConsumeResetCreditRequest {
  readonly kind?: ServerProviderResetKind;
  readonly attemptKey?: string;
  /** The account the claim was decided for; nothing is used once the login holds another. */
  readonly accountKey?: string;
}

export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ManagedServerProvider;
  /** Set by the registry from its driver's `privateAccountHomes`; clients read it on the snapshot. */
  readonly sharesAddedAccounts?: boolean;
  readonly fundingForWorkspace?: (input: {
    readonly cwd: string;
    readonly model: string;
    readonly provider: ServerProvider;
  }) => Effect.Effect<NonNullable<ServerProvider["auth"]["funding"]>>;
  readonly snapshotForCwd?: (
    cwd: string,
  ) => Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  readonly invalidateCaches?: Effect.Effect<void>;
  /**
   * A redeemed reset whose new limits could not be read back succeeds with a `warning`. With no
   * request the provider picks the reset itself; a request names the kind to claim (Claude) and the
   * idempotency key one run-out is redeemed under (Codex).
   */
  readonly consumeResetCredit?: (
    request?: ProviderConsumeResetCreditRequest,
  ) => Effect.Effect<ProviderConsumeResetCreditResult, ProviderDriverError>;
  readonly orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly textGeneration: ProviderTextGeneration;
  readonly auth?: ProviderAuthController;
  /** A login kept beside `auth` only to read this account's usage limits; see ProviderAuthPurpose. */
  readonly limitsAuth?: ProviderAuthController;
  readonly plugins?: ProviderPluginManagement;
  /** Published for local tools that read the login; set by drivers whose accounts they read. */
  readonly configFolder?: ProviderConfigFolder;
  /** Where this provider loads personal skills from; absent when it cannot take copied skills. */
  readonly personalSkillsDirectory?: string;
  /** Turns one skill on or off in the provider's own config; absent when it has no such switch. */
  readonly setSkillEnabled?: (input: {
    /** The skill's name as the provider lists it. */
    readonly name: string;
    /** The skill's SKILL.md. */
    readonly path: string;
    readonly enabled: boolean;
  }) => Effect.Effect<void, ProviderSkillError>;
  readonly mcp?: ProviderMcpManagement;
  /**
   * The whole environment the provider's own shell commands get in `cwd` during a turn on
   * `modelSelection` when they would otherwise inherit `inherited`. A driver whose settings cannot
   * change the account's variables it starts its agent with leaves it out; the instance registry
   * gives those commands just that.
   */
  readonly shellEnvironment?: (
    cwd: string,
    inherited: Readonly<Record<string, string>>,
    modelSelection: ModelSelection,
  ) => Effect.Effect<Readonly<NodeJS.ProcessEnv>, ProviderDriverError>;
  readonly acpSessionManagement?: {
    readonly listSessions: (input: {
      readonly cwd: string;
      readonly cursor?: string;
    }) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly logout: (cwd: string) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly deleteSession: (input: {
      readonly cwd: string;
      readonly sessionId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly listProviders: (
      cwd: string,
    ) => Effect.Effect<AcpRegistryListProvidersResult, AcpRegistryOperationError>;
    readonly setProvider: (
      input: Omit<AcpRegistrySetProviderInput, "instanceId" | "projectId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly disableProvider: (input: {
      readonly cwd: string;
      readonly providerId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
  };
}

export interface ProviderPluginCatalog {
  readonly plugins: ReadonlyArray<ProviderPlugin>;
  readonly marketplaces: ReadonlyArray<ProviderPluginMarketplace>;
  readonly warnings: ReadonlyArray<string>;
  /** Ids the provider features; browsing lists them before the rest. */
  readonly featuredIds?: ReadonlyArray<string>;
}

/** Plugins in the provider's own home, through its own CLI or protocol. */
export interface ProviderPluginManagement {
  readonly catalog: Effect.Effect<ProviderPluginCatalog, ProviderPluginError>;
  readonly install: (
    pluginId: string,
  ) => Effect.Effect<ProviderPluginInstallResult, ProviderPluginError>;
  readonly uninstall: (pluginId: string) => Effect.Effect<void, ProviderPluginError>;
  readonly setEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Effect.Effect<void, ProviderPluginError>;
  readonly addMarketplace: (
    source: string,
  ) => Effect.Effect<ProviderPluginAddMarketplaceResult, ProviderPluginError>;
}

/** A sign-in to one MCP server that stays open until its scope closes. */
export interface ProviderMcpSignIn {
  /** Absent when the provider signed in without asking the user. */
  readonly authorizationUrl: string | undefined;
  /** Succeeds once the provider holds a token for the server. */
  readonly completed: Effect.Effect<void, ProviderMcpError>;
  /** Hands over the address the provider's local callback page would have received. */
  readonly submitCallbackUrl: (callbackUrl: string) => Effect.Effect<void, ProviderMcpError>;
}

/** MCP servers in the provider's own config, through its own CLI or protocol. */
export interface ProviderMcpManagement {
  readonly list: Effect.Effect<ReadonlyArray<ProviderMcpServer>, ProviderMcpError>;
  readonly add: (
    name: string,
    server: ProviderMcpServerConfig,
  ) => Effect.Effect<void, ProviderMcpError>;
  readonly remove: (name: string) => Effect.Effect<void, ProviderMcpError>;
  readonly signIn: (
    name: string,
  ) => Effect.Effect<ProviderMcpSignIn, ProviderMcpError, Scope.Scope>;
  readonly signOut: (name: string) => Effect.Effect<void, ProviderMcpError>;
  /** The stored server an edit starts from. */
  readonly read: (name: string) => Effect.Effect<ProviderMcpServerConfig, ProviderMcpError>;
  /** Replaces the address or command in place; the provider's other settings for it stay. */
  readonly edit: (
    name: string,
    server: ProviderMcpServerConfig,
  ) => Effect.Effect<void, ProviderMcpError>;
  readonly setEnabled: (name: string, enabled: boolean) => Effect.Effect<void, ProviderMcpError>;
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ResolvedProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/** create calls with different instanceId/config must share no mutable state. */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  // Codec keeps DecodingServices = never; Schema would widen it through AnyProviderDriver.
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /** Failures become unavailable snapshots; never throw defects. */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;
