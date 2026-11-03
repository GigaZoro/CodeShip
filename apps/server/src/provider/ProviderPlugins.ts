import {
  PROVIDER_PLUGINS_PAGE_SIZE,
  ProviderPluginError,
  type ProviderInstanceId,
  type ProviderPlugin,
  type ProviderPluginAddMarketplaceInput,
  type ProviderPluginAddMarketplaceResult,
  type ProviderPluginInput,
  type ProviderPluginInstallResult,
  type ProviderPluginOperation,
  type ProviderPluginSetEnabledInput,
  type ProviderPluginsListInput,
  type ProviderPluginsListResult,
} from "@t3tools/contracts";
import type {
  ProviderPluginCatalog,
  ProviderPluginManagement,
} from "@t3tools/provider-core/server/driver";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

// Catalogs run to thousands of plugins and take a provider process to read; searching
// re-reads the copy, and a change or an explicit refresh drops it.
const CATALOG_TTL = Duration.minutes(5);

const pluginLabel = (plugin: ProviderPlugin) => plugin.displayName ?? plugin.name;

const byLabel = (left: ProviderPlugin, right: ProviderPlugin) =>
  pluginLabel(left).localeCompare(pluginLabel(right));

/** 2 when a name starts with the query, 1 when it contains it, 0 for other fields. */
function nameRelevance(plugin: ProviderPlugin, query: string) {
  const names = [plugin.name, plugin.displayName ?? ""].map((name) => name.toLocaleLowerCase());
  if (names.some((name) => name.startsWith(query))) return 2;
  return names.some((name) => name.includes(query)) ? 1 : 0;
}

/** Installed plugins by name; the rest by relevance, the provider's featured picks, then popularity. */
export function searchProviderPlugins(
  catalog: ProviderPluginCatalog,
  query: string,
  limit: number,
): ProviderPluginsListResult {
  const folded = query.trim().toLocaleLowerCase();
  const terms = folded.split(/\s+/).filter((term) => term.length > 0);
  const matches = (plugin: ProviderPlugin) => {
    if (terms.length === 0) return true;
    const haystack = [
      plugin.id,
      plugin.name,
      plugin.displayName ?? "",
      plugin.description ?? "",
      plugin.marketplace,
    ]
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const featured = new Map((catalog.featuredIds ?? []).map((id, index) => [id, index]));
  const matching = catalog.plugins.filter(matches);
  const available = matching
    .filter((plugin) => !plugin.installed)
    .map((plugin) => ({
      plugin,
      relevance: folded ? nameRelevance(plugin, folded) : 0,
      featured: featured.get(plugin.id) ?? Number.POSITIVE_INFINITY,
    }))
    .toSorted(
      (left, right) =>
        right.relevance - left.relevance ||
        left.featured - right.featured ||
        (right.plugin.installCount ?? -1) - (left.plugin.installCount ?? -1) ||
        byLabel(left.plugin, right.plugin),
    )
    .map(({ plugin }) => plugin);
  return {
    installed: matching.filter((plugin) => plugin.installed).toSorted(byLabel),
    available: available.slice(0, limit),
    availableTotal: available.length,
    marketplaces: catalog.marketplaces,
    warnings: catalog.warnings,
  };
}

export class ProviderPlugins extends Context.Service<
  ProviderPlugins,
  {
    readonly list: (
      input: ProviderPluginsListInput,
    ) => Effect.Effect<ProviderPluginsListResult, ProviderPluginError>;
    readonly install: (
      input: ProviderPluginInput,
    ) => Effect.Effect<ProviderPluginInstallResult, ProviderPluginError>;
    readonly uninstall: (input: ProviderPluginInput) => Effect.Effect<void, ProviderPluginError>;
    readonly setEnabled: (
      input: ProviderPluginSetEnabledInput,
    ) => Effect.Effect<void, ProviderPluginError>;
    readonly addMarketplace: (
      input: ProviderPluginAddMarketplaceInput,
    ) => Effect.Effect<ProviderPluginAddMarketplaceResult, ProviderPluginError>;
  }
>()("t3/provider/ProviderPlugins") {}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const scope = yield* Effect.scope;

  const management = Effect.fn("ProviderPlugins.management")(function* (
    instanceId: ProviderInstanceId,
    operation: ProviderPluginOperation,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new ProviderPluginError({ operation, instanceId, reason: "instanceNotFound" });
    }
    if (instance.plugins === undefined) {
      return yield* new ProviderPluginError({ operation, instanceId, reason: "unsupported" });
    }
    return instance.plugins;
  });

  const catalogs = yield* Cache.makeWith(
    (instanceId: ProviderInstanceId) =>
      management(instanceId, "list").pipe(Effect.flatMap((plugins) => plugins.catalog)),
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? CATALOG_TTL : Duration.zero),
    },
  );

  /** Runs a change, then drops stale catalogs and lets each provider on the home pick up new skills. */
  const change = Effect.fn("ProviderPlugins.change")(function* <A>(
    instanceId: ProviderInstanceId,
    operation: ProviderPluginOperation,
    run: (plugins: ProviderPluginManagement) => Effect.Effect<A, ProviderPluginError>,
  ) {
    const plugins = yield* management(instanceId, operation);
    const sharing = ProviderInstanceRegistry.instancesSharingHome(
      yield* instances.listInstances,
      instanceId,
    );
    return yield* run(plugins).pipe(
      Effect.ensuring(
        Effect.forEach(sharing, (id) => Cache.invalidate(catalogs, id), { discard: true }),
      ),
      Effect.tap(() =>
        Effect.forEach(
          sharing,
          (id) =>
            // The provider refresh outlives the request, whose scope would interrupt it.
            providers
              .refreshInstance(id)
              .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope)),
          { discard: true },
        ),
      ),
    );
  });

  return ProviderPlugins.of({
    list: Effect.fn("ProviderPlugins.list")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      if (input.refresh === true) yield* Cache.invalidate(catalogs, input.instanceId);
      const catalog = yield* Cache.get(catalogs, input.instanceId);
      return searchProviderPlugins(catalog, input.query, input.limit ?? PROVIDER_PLUGINS_PAGE_SIZE);
    }),
    install: Effect.fn("ProviderPlugins.install")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      return yield* change(input.instanceId, "install", (plugins) =>
        plugins.install(input.pluginId),
      );
    }),
    uninstall: Effect.fn("ProviderPlugins.uninstall")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      yield* change(input.instanceId, "uninstall", (plugins) => plugins.uninstall(input.pluginId));
    }),
    setEnabled: Effect.fn("ProviderPlugins.setEnabled")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      yield* change(input.instanceId, input.enabled ? "enable" : "disable", (plugins) =>
        plugins.setEnabled(input.pluginId, input.enabled),
      );
    }),
    addMarketplace: Effect.fn("ProviderPlugins.addMarketplace")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      return yield* change(input.instanceId, "addMarketplace", (plugins) =>
        plugins.addMarketplace(input.source),
      );
    }),
  });
});

export const layer = Layer.effect(ProviderPlugins, make);
