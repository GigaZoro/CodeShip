import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PROVIDER_PLUGINS_PAGE_SIZE = 50;
const PROVIDER_PLUGINS_MAX_LIMIT = 500;
const PROVIDER_PLUGIN_DESCRIPTION_MAX_LENGTH = 500;

/** The provider's own plugin id, `name@marketplace` for both Claude and Codex. */
export const ProviderPluginId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ProviderPluginId = typeof ProviderPluginId.Type;

export function splitProviderPluginId(id: string) {
  const at = id.lastIndexOf("@");
  return at > 0
    ? { name: id.slice(0, at), marketplace: id.slice(at + 1) }
    : { name: id, marketplace: "" };
}

export const ProviderPlugin = Schema.Struct({
  id: ProviderPluginId,
  name: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROVIDER_PLUGIN_DESCRIPTION_MAX_LENGTH)),
  ),
  marketplace: Schema.String,
  version: Schema.optionalKey(Schema.String),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  installCount: Schema.optionalKey(NonNegativeInt),
  /** False when the provider keeps the plugin installed itself, such as plugins synced from claude.ai. */
  removable: Schema.Boolean,
});
export type ProviderPlugin = typeof ProviderPlugin.Type;

export const ProviderPluginMarketplace = Schema.Struct({
  name: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});
export type ProviderPluginMarketplace = typeof ProviderPluginMarketplace.Type;

export const ProviderPluginsListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  query: TrimmedString.check(Schema.isMaxLength(120)),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PROVIDER_PLUGINS_MAX_LIMIT })),
  ),
  /** Reads the provider's catalog again instead of the copy kept for a few minutes. */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type ProviderPluginsListInput = typeof ProviderPluginsListInput.Type;

export const ProviderPluginsListResult = Schema.Struct({
  installed: Schema.Array(ProviderPlugin),
  /** Plugins not yet installed that match the query, most popular first, capped at `limit`. */
  available: Schema.Array(ProviderPlugin).check(Schema.isMaxLength(PROVIDER_PLUGINS_MAX_LIMIT)),
  availableTotal: NonNegativeInt,
  marketplaces: Schema.Array(ProviderPluginMarketplace),
  /** Marketplaces the provider could not read. */
  warnings: Schema.Array(Schema.String),
});
export type ProviderPluginsListResult = typeof ProviderPluginsListResult.Type;

export const ProviderPluginInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  pluginId: ProviderPluginId,
});
export type ProviderPluginInput = typeof ProviderPluginInput.Type;

export const ProviderPluginSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  pluginId: ProviderPluginId,
  enabled: Schema.Boolean,
});
export type ProviderPluginSetEnabledInput = typeof ProviderPluginSetEnabledInput.Type;

export const ProviderPluginApp = Schema.Struct({
  name: Schema.String,
  installUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type ProviderPluginApp = typeof ProviderPluginApp.Type;

export const ProviderPluginInstallResult = Schema.Struct({
  /** Apps the plugin connects to that need a sign-in before it works. */
  appsNeedingAuth: Schema.Array(ProviderPluginApp),
});
export type ProviderPluginInstallResult = typeof ProviderPluginInstallResult.Type;

export const ProviderPluginAddMarketplaceInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** A GitHub `owner/repo`, a git or https URL, or a local path. */
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type ProviderPluginAddMarketplaceInput = typeof ProviderPluginAddMarketplaceInput.Type;

export const ProviderPluginAddMarketplaceResult = Schema.Struct({
  marketplace: Schema.String,
});
export type ProviderPluginAddMarketplaceResult = typeof ProviderPluginAddMarketplaceResult.Type;

export const ProviderPluginOperation = Schema.Literals([
  "list",
  "install",
  "uninstall",
  "enable",
  "disable",
  "addMarketplace",
]);
export type ProviderPluginOperation = typeof ProviderPluginOperation.Type;

export const ProviderPluginErrorReason = Schema.Literals([
  "instanceNotFound",
  "unsupported",
  "providerFailed",
]);
export type ProviderPluginErrorReason = typeof ProviderPluginErrorReason.Type;

const FAILED_OPERATION_MESSAGES: Record<ProviderPluginOperation, string> = {
  list: "Could not read the provider's plugins.",
  install: "Could not install the plugin.",
  uninstall: "Could not uninstall the plugin.",
  enable: "Could not enable the plugin.",
  disable: "Could not disable the plugin.",
  addMarketplace: "Could not add the marketplace.",
};

export class ProviderPluginError extends Schema.TaggedError<ProviderPluginError>()(
  "ProviderPluginError",
  {
    operation: ProviderPluginOperation,
    instanceId: ProviderInstanceId,
    reason: ProviderPluginErrorReason,
    /**
     * The provider's own one-line reason, such as a plugin missing from its marketplace. Users
     * need it to act, as with device boot diagnostics, so it is capped instead of withheld.
     */
    providerMessage: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "instanceNotFound":
        return "This provider is no longer configured.";
      case "unsupported":
        return "This provider does not support plugins.";
      case "providerFailed":
        return this.providerMessage ?? FAILED_OPERATION_MESSAGES[this.operation];
    }
  }
}

/** Plugin descriptions run long in some marketplaces; a list row needs a couple of lines. */
export function boundedProviderPluginDescription(text: string | null | undefined) {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > PROVIDER_PLUGIN_DESCRIPTION_MAX_LENGTH
    ? `${trimmed.slice(0, PROVIDER_PLUGIN_DESCRIPTION_MAX_LENGTH - 1)}…`
    : trimmed;
}
