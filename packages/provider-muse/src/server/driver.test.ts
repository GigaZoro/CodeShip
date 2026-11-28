import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { MuseDriver } from "./driver.ts";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Muse must not make an HTTP request")),
    ),
  ),
);

it.layer(layerTest)("MuseDriver", (it) => {
  it.effect.each([
    ["no key of its own", [], { PATH: "/bin", MUSE_NO_AUTO_UPDATE: "1" }],
    [
      "its own key",
      [{ name: "META_API_KEY", value: "account", sensitive: true }],
      { PATH: "/bin", MUSE_NO_AUTO_UPDATE: "1", META_API_KEY: "account" },
    ],
  ] as const)(
    "gives an instance with %s the shell environment Muse runs with, never an inherited META_API_KEY",
    ([, environment, expected]) =>
      Effect.gen(function* () {
        const instance = yield* MuseDriver.create({
          instanceId: ProviderInstanceId.make("muse-shell"),
          displayName: "Muse test",
          enabled: false,
          environment,
          config: MuseDriver.defaultConfig(),
        });
        expect(instance.shellEnvironment).toBeDefined();
        expect(
          yield* instance.shellEnvironment!(
            "/work",
            { PATH: "/bin", META_API_KEY: "inherited" },
            { instanceId: ProviderInstanceId.make("muse-shell"), model: "muse" },
          ),
        ).toEqual(expected);
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Muse must not spawn a process")),
        ),
        Effect.scoped,
      ),
  );
});
