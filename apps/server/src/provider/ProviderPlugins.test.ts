import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderPlugin,
  ProviderPluginError,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance, ProviderPluginCatalog } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderPlugins from "./ProviderPlugins.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const plugin = (
  overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "name">,
): ProviderPlugin => ({
  id: `${overrides.name}@market`,
  marketplace: "market",
  installed: false,
  enabled: false,
  removable: true,
  ...overrides,
});

const catalog: ProviderPluginCatalog = {
  plugins: [
    plugin({ name: "zeta", installed: true, enabled: true }),
    plugin({ name: "alpha", installed: true, enabled: false }),
    plugin({ name: "popular", description: "Review pull requests", installCount: 900 }),
    plugin({ name: "niche", description: "Review code in Rust", installCount: 5 }),
    plugin({ name: "review-kit", installCount: 1 }),
    plugin({ name: "picked" }),
    plugin({ name: "unknown-count" }),
  ],
  marketplaces: [{ name: "market" }],
  warnings: ["remote catalog needs sign-in"],
  featuredIds: ["picked@market"],
};

it("searchProviderPlugins ranks name matches, then featured picks, then popularity", () => {
  const browse = ProviderPlugins.searchProviderPlugins(catalog, "", 3);
  assert.deepEqual(
    browse.installed.map((entry) => entry.name),
    ["alpha", "zeta"],
  );
  assert.deepEqual(
    browse.available.map((entry) => entry.name),
    ["picked", "popular", "niche"],
  );
  assert.equal(browse.availableTotal, 5);
  assert.deepEqual(browse.warnings, ["remote catalog needs sign-in"]);

  const review = ProviderPlugins.searchProviderPlugins(catalog, "review", 10);
  assert.deepEqual(
    review.available.map((entry) => entry.name),
    ["review-kit", "popular", "niche"],
  );
  assert.deepEqual(review.installed, []);

  const allTerms = ProviderPlugins.searchProviderPlugins(catalog, "REVIEW rust", 10);
  assert.deepEqual(
    allTerms.available.map((entry) => entry.name),
    ["niche"],
  );
});

const instanceId = ProviderInstanceId.make("claudeAgent");

const makeHarness = Effect.gen(function* () {
  const catalogReads = yield* Ref.make(0);
  const refreshed = yield* Deferred.make<ProviderInstanceId>();
  const installed = yield* Ref.make<ReadonlyArray<string>>([]);
  const plugins: NonNullable<ProviderInstance["plugins"]> = {
    catalog: Ref.update(catalogReads, (count) => count + 1).pipe(Effect.as(catalog)),
    install: (pluginId) =>
      pluginId === "broken@market"
        ? Effect.fail(
            new ProviderPluginError({
              operation: "install",
              instanceId,
              reason: "providerFailed",
              providerMessage: "Plugin not found in marketplace",
            }),
          )
        : Ref.update(installed, (ids) => [...ids, pluginId]).pipe(
            Effect.as({ appsNeedingAuth: [] }),
          ),
    uninstall: () => Effect.void,
    setEnabled: () => Effect.void,
    addMarketplace: (source) => Effect.succeed({ marketplace: source }),
  };
  // Only the fields ProviderPlugins reads; the rest of an instance is irrelevant here.
  const instances = {
    claudeAgent: { instanceId, plugins } as unknown as ProviderInstance,
    cursor: { instanceId: ProviderInstanceId.make("cursor") } as unknown as ProviderInstance,
  };
  const layer = ProviderPlugins.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(instances[id as keyof typeof instances]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        refreshInstance: (id) =>
          Deferred.succeed(refreshed, id).pipe(Effect.as<ReadonlyArray<ServerProvider>>([])),
      }),
    ),
  );
  return { catalogReads, refreshed, installed, layer };
});

it.effect("ProviderPlugins reuses the catalog until a change or an explicit refresh", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ProviderPlugins.ProviderPlugins;
      yield* service.list({ instanceId, query: "" });
      yield* service.list({ instanceId, query: "review" });
      assert.equal(yield* Ref.get(harness.catalogReads), 1);

      yield* service.install({ instanceId, pluginId: "popular@market" });
      assert.deepEqual(yield* Ref.get(harness.installed), ["popular@market"]);
      // New plugin skills reach the provider snapshot.
      assert.equal(yield* Deferred.await(harness.refreshed), instanceId);
      yield* service.list({ instanceId, query: "" });
      assert.equal(yield* Ref.get(harness.catalogReads), 2);

      // A failed change may still have touched the provider's files.
      const failed = yield* service
        .install({ instanceId, pluginId: "broken@market" })
        .pipe(Effect.flip);
      assert.equal(failed.message, "Plugin not found in marketplace");
      yield* service.list({ instanceId, query: "" });
      assert.equal(yield* Ref.get(harness.catalogReads), 3);

      yield* service.list({ instanceId, query: "", refresh: true });
      assert.equal(yield* Ref.get(harness.catalogReads), 4);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("ProviderPlugins names missing and unsupported providers", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ProviderPlugins.ProviderPlugins;
      const unsupported = yield* service
        .list({ instanceId: ProviderInstanceId.make("cursor"), query: "" })
        .pipe(Effect.flip);
      assert.equal(unsupported.reason, "unsupported");
      const missing = yield* service
        .setEnabled({ instanceId: ProviderInstanceId.make("gone"), pluginId: "a@b", enabled: true })
        .pipe(Effect.flip);
      assert.equal(missing.reason, "instanceNotFound");
      assert.equal(missing.operation, "enable");
    }).pipe(Effect.provide(harness.layer));
  }),
);
