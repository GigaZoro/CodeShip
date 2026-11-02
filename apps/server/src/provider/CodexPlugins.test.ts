import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { codexPluginCatalog, makeCodexPluginManagement } from "./CodexPlugins.ts";

type Summary = CodexSchema.V2PluginListResponse["marketplaces"][number]["plugins"][number];

const summary = (overrides: Partial<Summary> & Pick<Summary, "id" | "name">): Summary => ({
  authPolicy: "ON_USE",
  enabled: false,
  installed: false,
  installPolicy: "AVAILABLE",
  source: { type: "remote" },
  ...overrides,
});

const response: CodexSchema.V2PluginListResponse = {
  featuredPluginIds: ["gmail@curated"],
  marketplaceLoadErrors: [{ marketplacePath: "/broken", message: "invalid marketplace.json" }],
  marketplaces: [
    {
      name: "dale-local",
      path: "/home/dale/.agents/plugins/marketplace.json",
      interface: { displayName: "Dale" },
      plugins: [
        summary({
          id: "dale@dale-local",
          name: "dale",
          installed: true,
          enabled: true,
          localVersion: "0.4.0",
          interface: {
            capabilities: [],
            screenshotUrls: [],
            screenshots: [],
            displayName: "Dale",
            shortDescription: "Think, delegate, verify, and resume.",
          },
        }),
      ],
    },
    {
      name: "curated",
      plugins: [
        summary({
          id: "gmail@curated",
          name: "gmail",
          installPolicy: "INSTALLED_BY_DEFAULT",
          installed: true,
          enabled: false,
          interface: {
            capabilities: [],
            screenshotUrls: [],
            screenshots: [],
            displayName: "Gmail",
            longDescription: "Read and manage Gmail",
          },
        }),
        summary({ id: "blocked@curated", name: "blocked", availability: "DISABLED_BY_ADMIN" }),
        summary({ id: "hidden@curated", name: "hidden", installPolicy: "NOT_AVAILABLE" }),
        // Not installed, so Codex's enabled flag means nothing yet.
        summary({ id: "drive@curated", name: "drive", enabled: true }),
      ],
    },
  ],
};

it("codexPluginCatalog keeps what Codex offers and where each marketplace lives", () => {
  const { catalog, locations } = codexPluginCatalog(response);
  assert.deepEqual(catalog.plugins, [
    {
      id: "dale@dale-local",
      name: "dale",
      displayName: "Dale",
      description: "Think, delegate, verify, and resume.",
      marketplace: "dale-local",
      version: "0.4.0",
      installed: true,
      enabled: true,
      removable: true,
    },
    {
      id: "gmail@curated",
      name: "gmail",
      displayName: "Gmail",
      description: "Read and manage Gmail",
      marketplace: "curated",
      installed: true,
      enabled: false,
      removable: false,
    },
    {
      id: "drive@curated",
      name: "drive",
      marketplace: "curated",
      installed: false,
      enabled: false,
      removable: true,
    },
  ]);
  assert.deepEqual(catalog.marketplaces, [
    { name: "dale-local", displayName: "Dale" },
    { name: "curated" },
  ]);
  assert.deepEqual(catalog.warnings, ["invalid marketplace.json"]);
  assert.deepEqual(catalog.featuredIds, ["gmail@curated"]);
  assert.deepEqual(locations.get("dale-local"), {
    kind: "local",
    path: "/home/dale/.agents/plugins/marketplace.json",
  });
  assert.deepEqual(locations.get("curated"), { kind: "remote" });
});

it.effect("installs from a local marketplace file or the remote catalog by name", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
    // Only `request` is used; the stub answers the methods plugin management calls.
    const client = {
      request: (method: string, payload: unknown) =>
        Ref.update(requests, (all) => [...all, [method, payload] as const]).pipe(
          Effect.as(
            method === "plugin/list"
              ? response
              : method === "plugin/install"
                ? {
                    authPolicy: "ON_USE",
                    appsNeedingAuth: [{ id: "gmail", name: "Gmail", installUrl: "https://x.test" }],
                  }
                : {},
          ),
        ),
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const plugins = yield* makeCodexPluginManagement({
      instanceId: ProviderInstanceId.make("codex"),
      openClient: Effect.succeed(client),
    });

    yield* plugins.install("dale@dale-local");
    const installed = yield* plugins.install("gmail@curated");
    assert.deepEqual(installed.appsNeedingAuth, [{ name: "Gmail", installUrl: "https://x.test" }]);
    yield* plugins.setEnabled("dale@dale-local", false);

    assert.deepEqual(yield* Ref.get(requests), [
      ["plugin/list", {}],
      [
        "plugin/install",
        { pluginName: "dale", marketplacePath: "/home/dale/.agents/plugins/marketplace.json" },
      ],
      ["plugin/install", { pluginName: "gmail", remoteMarketplaceName: "curated" }],
      [
        "config/value/write",
        {
          keyPath: "plugins",
          value: { "dale@dale-local": { enabled: false } },
          mergeStrategy: "upsert",
        },
      ],
    ]);
  }),
);
