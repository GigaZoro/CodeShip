import {
  boundedProviderPluginDescription,
  ProviderPluginError,
  splitProviderPluginId,
  type ProviderInstanceId,
  type ProviderPlugin,
  type ProviderPluginOperation,
} from "@t3tools/contracts";
import type {
  ProviderPluginCatalog,
  ProviderPluginManagement,
} from "@t3tools/provider-core/server/driver";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

const CATALOG_TIMEOUT = Duration.minutes(1);
// Installs and marketplaces fetch from git or the remote catalog.
const FETCH_TIMEOUT = Duration.minutes(3);

/** Where Codex installs a marketplace's plugins from: a local marketplace file, or its remote catalog. */
type MarketplaceLocation =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "remote" };

export function codexPluginCatalog(response: CodexSchema.V2PluginListResponse): {
  readonly catalog: ProviderPluginCatalog;
  readonly locations: ReadonlyMap<string, MarketplaceLocation>;
} {
  const locations = new Map<string, MarketplaceLocation>();
  const plugins: Array<ProviderPlugin> = [];
  for (const marketplace of response.marketplaces) {
    locations.set(
      marketplace.name,
      marketplace.path ? { kind: "local", path: marketplace.path } : { kind: "remote" },
    );
    for (const plugin of marketplace.plugins) {
      const offered =
        plugin.installPolicy !== "NOT_AVAILABLE" && plugin.availability !== "DISABLED_BY_ADMIN";
      if (!plugin.installed && !offered) continue;
      const displayName = plugin.interface?.displayName?.trim();
      const description = boundedProviderPluginDescription(
        plugin.interface?.shortDescription ?? plugin.interface?.longDescription,
      );
      const version = plugin.version ?? plugin.localVersion;
      plugins.push({
        id: plugin.id,
        name: plugin.name,
        ...(displayName && displayName !== plugin.name ? { displayName } : {}),
        ...(description ? { description } : {}),
        marketplace: marketplace.name,
        ...(version ? { version } : {}),
        installed: plugin.installed,
        enabled: plugin.installed && plugin.enabled,
        removable: plugin.installPolicy !== "INSTALLED_BY_DEFAULT",
      });
    }
  }
  return {
    catalog: {
      plugins,
      marketplaces: response.marketplaces.map((marketplace) => {
        const displayName = marketplace.interface?.displayName?.trim();
        return { name: marketplace.name, ...(displayName ? { displayName } : {}) };
      }),
      warnings: (response.marketplaceLoadErrors ?? []).map((error) => error.message),
      featuredIds: response.featuredPluginIds ?? [],
    },
    locations,
  };
}

/** Manages the plugins in a Codex home through its app server, which owns `config.toml`. */
export const makeCodexPluginManagement = Effect.fn("makeCodexPluginManagement")(function* <
  OpenError,
>(options: {
  readonly instanceId: ProviderInstanceId;
  /** An initialized app server for this instance's Codex home, closed with the scope. */
  readonly openClient: Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    OpenError,
    Scope.Scope
  >;
}) {
  const locations = yield* Ref.make<ReadonlyMap<string, MarketplaceLocation>>(new Map());
  // Codex rewrites config.toml for every change.
  const writes = yield* Semaphore.make(1);

  const failure = (
    operation: ProviderPluginOperation,
    cause: OpenError | CodexErrors.CodexAppServerError | Cause.TimeoutError | ProviderPluginError,
  ) =>
    new ProviderPluginError({
      operation,
      instanceId: options.instanceId,
      reason: "providerFailed",
      // JSON-RPC errors carry Codex's own reason, such as a missing ChatGPT sign-in.
      ...(cause instanceof Error && cause.message.trim()
        ? { providerMessage: cause.message.trim().slice(0, 500) }
        : {}),
      cause,
    });

  const withClient = <A>(
    operation: ProviderPluginOperation,
    timeout: Duration.Input,
    use: (
      client: CodexClient.CodexAppServerClient["Service"],
    ) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ) =>
    options.openClient.pipe(
      Effect.flatMap(use),
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError((cause) => failure(operation, cause)),
    );

  const catalog: ProviderPluginManagement["catalog"] = withClient(
    "list",
    CATALOG_TIMEOUT,
    (client) => client.request("plugin/list", {}),
  ).pipe(
    Effect.map(codexPluginCatalog),
    Effect.tap((result) => Ref.set(locations, result.locations)),
    Effect.map((result) => result.catalog),
  );

  const locate = Effect.fn("CodexPlugins.locate")(function* (marketplace: string) {
    const known = (yield* Ref.get(locations)).get(marketplace);
    if (known) return known;
    yield* catalog;
    return (yield* Ref.get(locations)).get(marketplace);
  });

  return {
    catalog,
    install: Effect.fn("CodexPlugins.install")(function* (pluginId) {
      const { name: pluginName, marketplace } = splitProviderPluginId(pluginId);
      const location = yield* locate(marketplace).pipe(
        Effect.mapError((error) => failure("install", error)),
      );
      if (!location) {
        return yield* new ProviderPluginError({
          operation: "install",
          instanceId: options.instanceId,
          reason: "providerFailed",
          providerMessage: `Codex has no marketplace named ${marketplace || "for this plugin"}.`,
        });
      }
      const response = yield* withClient("install", FETCH_TIMEOUT, (client) =>
        client.request(
          "plugin/install",
          location.kind === "local"
            ? { pluginName, marketplacePath: location.path }
            : { pluginName, remoteMarketplaceName: marketplace },
        ),
      ).pipe(writes.withPermits(1));
      return {
        appsNeedingAuth: response.appsNeedingAuth.map((app) => ({
          name: app.name,
          ...(app.installUrl ? { installUrl: app.installUrl } : {}),
        })),
      };
    }),
    uninstall: (pluginId) =>
      withClient("uninstall", CATALOG_TIMEOUT, (client) =>
        client.request("plugin/uninstall", { pluginId }),
      ).pipe(writes.withPermits(1), Effect.asVoid),
    setEnabled: (pluginId, enabled) =>
      withClient(enabled ? "enable" : "disable", CATALOG_TIMEOUT, (client) =>
        // Upserting the table keeps ids with dots out of the key path and other keys in place.
        client.request("config/value/write", {
          keyPath: "plugins",
          value: { [pluginId]: { enabled } },
          mergeStrategy: "upsert",
        }),
      ).pipe(writes.withPermits(1), Effect.asVoid),
    addMarketplace: (source) =>
      withClient("addMarketplace", FETCH_TIMEOUT, (client) =>
        client.request("marketplace/add", { source }),
      ).pipe(
        writes.withPermits(1),
        Effect.map((response) => ({ marketplace: response.marketplaceName })),
      ),
  } satisfies ProviderPluginManagement;
});
