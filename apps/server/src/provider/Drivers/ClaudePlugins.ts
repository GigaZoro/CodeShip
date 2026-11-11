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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import { runClaudeCli } from "./ClaudeExecutable.ts";

const ClaudeInstalledPlugin = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  installPath: Schema.optional(Schema.String),
});

const ClaudeAvailablePlugin = Schema.Struct({
  pluginId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  marketplaceName: Schema.String,
  version: Schema.optional(Schema.String),
  installCount: Schema.optional(Schema.Number),
});

const ClaudePluginList = Schema.Struct({
  installed: Schema.Array(ClaudeInstalledPlugin),
  available: Schema.Array(ClaudeAvailablePlugin),
});
type ClaudePluginList = typeof ClaudePluginList.Type;

const ClaudeMarketplaces = Schema.Array(Schema.Struct({ name: Schema.String }));

/** The one JSON line `claude plugin <command> --json` prints for a mutation. */
const ClaudePluginCommandResult = Schema.Struct({
  outcome: Schema.String,
  message: Schema.optional(Schema.String),
  marketplace: Schema.optional(Schema.String),
});

const ClaudePluginManifest = Schema.Struct({ description: Schema.optional(Schema.String) });

const decodePluginList = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudePluginList));
const decodeMarketplaces = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeMarketplaces));
const decodeCommandResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudePluginCommandResult),
);
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudePluginManifest));

const LIST_TIMEOUT = Duration.seconds(30);
// Installs and marketplaces clone git repositories; Claude's own clone timeout is two minutes.
const FETCH_TIMEOUT = Duration.minutes(3);

/** Claude keeps plugins it syncs from claude.ai or an admin's managed settings installed itself. */
const PROVIDER_OWNED_SCOPES = new Set(["synced", "managed"]);

function claudePluginCatalog(
  list: ClaudePluginList,
  marketplaceNames: ReadonlyArray<string>,
  installedDescriptions: ReadonlyMap<string, string>,
): ProviderPluginCatalog {
  const installedIds = new Set(list.installed.map((plugin) => plugin.id));
  const installed = list.installed.map((plugin): ProviderPlugin => {
    const { name, marketplace } = splitProviderPluginId(plugin.id);
    const description = boundedProviderPluginDescription(installedDescriptions.get(plugin.id));
    return {
      id: plugin.id,
      name,
      marketplace,
      ...(description ? { description } : {}),
      ...(plugin.version && plugin.version !== "unknown" ? { version: plugin.version } : {}),
      installed: true,
      enabled: plugin.enabled !== false,
      removable: !PROVIDER_OWNED_SCOPES.has(plugin.scope ?? ""),
    };
  });
  const available = list.available
    .filter((plugin) => !installedIds.has(plugin.pluginId))
    .map((plugin): ProviderPlugin => {
      const description = boundedProviderPluginDescription(plugin.description);
      return {
        id: plugin.pluginId,
        name: plugin.name,
        marketplace: plugin.marketplaceName,
        ...(description ? { description } : {}),
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.installCount !== undefined && plugin.installCount >= 0
          ? { installCount: Math.floor(plugin.installCount) }
          : {}),
        installed: false,
        enabled: false,
        removable: true,
      };
    });
  const marketplaces = new Set([
    ...marketplaceNames,
    ...list.available.map((plugin) => plugin.marketplaceName),
  ]);
  return {
    plugins: [...installed, ...available],
    marketplaces: [...marketplaces].map((name) => ({ name })),
    warnings: [],
  };
}

/** Claude's own reason from a `--json` result line, which it prints last on stdout. */
export function claudePluginCommandMessage(stdout: string): {
  readonly ok: boolean;
  readonly message?: string;
  readonly marketplace?: string;
} {
  const lastLine = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  const result = decodeCommandResult(lastLine);
  if (Option.isNone(result)) return { ok: false };
  const { outcome, message, marketplace } = result.value;
  // Progress lines come first; the outcome is the last line of the message.
  const summary = message?.trim().split(/\r?\n/).at(-1)?.slice(0, 500);
  return {
    ok: outcome === "ok",
    ...(summary ? { message: summary } : {}),
    ...(marketplace ? { marketplace } : {}),
  };
}

/** Manages the plugins in a Claude config folder through `claude plugin`. */
export const makeClaudePluginManagement = Effect.fn("makeClaudePluginManagement")(
  function* (options: {
    readonly instanceId: ProviderInstanceId;
    readonly binaryPath: string;
    /** Carries `CLAUDE_CONFIG_DIR` for an added account's own folder. */
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Claude rewrites one settings file per scope for every change.
    const writes = yield* Semaphore.make(1);

    const failure = (
      operation: ProviderPluginOperation,
      providerMessage?: string,
      cause?: unknown,
    ) =>
      new ProviderPluginError({
        operation,
        instanceId: options.instanceId,
        reason: "providerFailed",
        ...(providerMessage ? { providerMessage } : {}),
        ...(cause === undefined ? {} : { cause }),
      });

    const run = Effect.fn("ClaudePlugins.run")(
      function* (
        _operation: ProviderPluginOperation,
        args: ReadonlyArray<string>,
        _timeout: Duration.Input,
      ) {
        return yield* runClaudeCli({
          binaryPath: options.binaryPath,
          args,
          environment: options.environment,
          cwd: options.cwd,
        });
      },
      (effect, operation, _args, timeout) =>
        effect.pipe(
          Effect.timeout(timeout),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) => failure(operation, undefined, cause)),
        ),
    );

    const mutate = (
      operation: ProviderPluginOperation,
      args: ReadonlyArray<string>,
      timeout: Duration.Input = LIST_TIMEOUT,
    ) =>
      run(operation, [...args, "--json"], timeout).pipe(
        Effect.flatMap((result) => {
          const parsed = claudePluginCommandMessage(result.stdout);
          return result.code === 0 && parsed.ok
            ? Effect.succeed(parsed)
            : Effect.fail(failure(operation, parsed.message));
        }),
        writes.withPermits(1),
      );

    // A plugin without a readable manifest lists without a description.
    const readDescription = (installPath: string) =>
      fileSystem.readFileString(path.join(installPath, ".claude-plugin", "plugin.json")).pipe(
        Effect.map((contents) => Option.getOrUndefined(decodeManifest(contents))?.description),
        Effect.orElseSucceed(() => undefined),
      );

    const catalog: ProviderPluginManagement["catalog"] = Effect.gen(function* () {
      const [listResult, marketplaceResult] = yield* Effect.all(
        [
          run("list", ["plugin", "list", "--json", "--available"], LIST_TIMEOUT),
          run("list", ["plugin", "marketplace", "list", "--json"], LIST_TIMEOUT),
        ],
        { concurrency: "unbounded" },
      );
      if (listResult.code !== 0) return yield* failure("list");
      const list = yield* decodePluginList(listResult.stdout).pipe(
        Effect.mapError((cause) => failure("list", undefined, cause)),
      );
      // Marketplaces only label the page; a failure here leaves the ones plugins name.
      const marketplaces =
        marketplaceResult.code === 0
          ? yield* decodeMarketplaces(marketplaceResult.stdout).pipe(Effect.orElseSucceed(() => []))
          : [];
      const descriptions = new Map<string, string>();
      yield* Effect.forEach(
        list.installed.flatMap(({ id, installPath }) => (installPath ? [{ id, installPath }] : [])),
        ({ id, installPath }) =>
          readDescription(installPath).pipe(
            Effect.map((description) => {
              if (description) descriptions.set(id, description);
            }),
          ),
        { concurrency: 8, discard: true },
      );
      return claudePluginCatalog(
        list,
        marketplaces.map((marketplace) => marketplace.name),
        descriptions,
      );
    });

    return {
      catalog,
      install: (pluginId) =>
        mutate("install", ["plugin", "install", pluginId, "--scope", "user"], FETCH_TIMEOUT).pipe(
          Effect.as({ appsNeedingAuth: [] }),
        ),
      // Keeping the plugin's saved data lets a reinstall pick up where it left off.
      uninstall: (pluginId) =>
        mutate("uninstall", ["plugin", "uninstall", pluginId, "--keep-data"]).pipe(Effect.asVoid),
      setEnabled: (pluginId, enabled) =>
        mutate(enabled ? "enable" : "disable", [
          "plugin",
          enabled ? "enable" : "disable",
          pluginId,
        ]).pipe(Effect.asVoid),
      addMarketplace: (source) =>
        mutate("addMarketplace", ["plugin", "marketplace", "add", source], FETCH_TIMEOUT).pipe(
          Effect.map((result) => ({ marketplace: result.marketplace ?? source })),
        ),
    } satisfies ProviderPluginManagement;
  },
);
