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
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { parse as parseToml } from "smol-toml";

import { grokHomePath } from "./grokHome.ts";
import { grokProbeEnvironment } from "./probeEnvironment.ts";

const GrokPluginEntry = Schema.Struct({
  status: Schema.String,
  name: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  /** The marketplace's display name; null for a plugin installed from a git URL or folder. */
  marketplace: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.String),
});
type GrokPluginEntry = typeof GrokPluginEntry.Type;

const decodePluginList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(GrokPluginEntry)),
);
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ description: Schema.optional(Schema.String) })),
);
const decodeDisabled = Schema.decodeUnknownOption(
  Schema.Struct({
    plugins: Schema.optional(
      Schema.Struct({ disabled: Schema.optional(Schema.Array(Schema.String)) }),
    ),
  }),
);

// `--available` reads every marketplace's cached git checkout.
const LIST_TIMEOUT = Duration.minutes(1);
// Installs and marketplaces clone git repositories.
const FETCH_TIMEOUT = Duration.minutes(3);

// Grok reads its own manifest first, then Claude's, which many plugins ship instead.
const MANIFEST_PATHS = [
  [".grok-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  ["plugin.json"],
] as const;

const UNREADABLE_CONFIG_WARNING =
  "Grok's config.toml could not be read, so plugins you turned off may show as on.";

const pluginId = (entry: GrokPluginEntry) =>
  entry.marketplace ? `${entry.name}@${entry.marketplace}` : entry.name;

/** One row per plugin and marketplace, since Grok installs the same name from two side by side. */
function grokPluginCatalog(
  entries: ReadonlyArray<GrokPluginEntry>,
  disabled: ReadonlySet<string>,
  installedDescriptions: ReadonlyMap<string, string>,
  warnings: ReadonlyArray<string>,
): ProviderPluginCatalog {
  const plugins = entries.map((entry): ProviderPlugin => {
    const id = pluginId(entry);
    const installed = entry.status === "installed";
    const description = boundedProviderPluginDescription(
      entry.description ?? installedDescriptions.get(id),
    );
    return {
      id,
      name: entry.name,
      marketplace: entry.marketplace ?? "",
      ...(description ? { description } : {}),
      ...(entry.version ? { version: entry.version } : {}),
      installed,
      // Grok turns plugins off by name, so every copy of a name shares one switch.
      enabled: installed && !disabled.has(entry.name),
      removable: true,
    };
  });
  const marketplaces = new Set(entries.flatMap((entry) => entry.marketplace ?? []));
  return {
    plugins,
    marketplaces: [...marketplaces].map((name) => ({ name })),
    warnings,
  };
}

/** Grok's reason for a failed command: its `Error:` line, or the first thing it said. */
export function grokPluginFailureMessage(output: {
  readonly stdout: string;
  readonly stderr: string;
}): string | undefined {
  const lines = `${output.stderr}\n${output.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines.find((candidate) => candidate.startsWith("Error:")) ?? lines[0];
  return line?.replace(/^Error:\s*/, "").slice(0, 500) || undefined;
}

/** The marketplace name from `Added marketplace source: <name> (<url>)`. */
function grokAddedMarketplaceName(stdout: string): string | undefined {
  return /^Added marketplace source: (.+?) \(/m.exec(stdout)?.[1]?.trim() || undefined;
}

/** Plugins Grok's user config turns off; a missing file turns none off. */
function grokDisabledPlugins(config: string): ReadonlySet<string> | undefined {
  let parsed: unknown;
  try {
    parsed = parseToml(config);
  } catch {
    return undefined;
  }
  const decoded = decodeDisabled(parsed);
  return Option.isSome(decoded) ? new Set(decoded.value.plugins?.disabled ?? []) : undefined;
}

/** Manages the plugins in a Grok home through `grok plugin`. */
export const makeGrokPluginManagement = Effect.fn("makeGrokPluginManagement")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = grokProbeEnvironment(options.environment);
  const command = options.binaryPath || "grok";
  const configPath = path.join(
    grokHomePath(path, environment, yield* HostProcess.HomeDirectory),
    "config.toml",
  );
  // Grok rewrites config.toml and its plugin registry for every change.
  const writes = yield* Semaphore.make(1);

  const failure = (operation: ProviderPluginOperation, providerMessage?: string, cause?: unknown) =>
    new ProviderPluginError({
      operation,
      instanceId: options.instanceId,
      reason: "providerFailed",
      ...(providerMessage ? { providerMessage } : {}),
      ...(cause === undefined ? {} : { cause }),
    });

  const run = Effect.fn("GrokPlugins.run")(
    function* (
      _operation: ProviderPluginOperation,
      args: ReadonlyArray<string>,
      _timeout: Duration.Input,
    ) {
      const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
      return yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
          cwd: options.cwd,
        }),
      );
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
    run(operation, args, timeout).pipe(
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) => failure(operation, grokPluginFailureMessage(result)),
      ),
      writes.withPermits(1),
    );

  const readDisabled = fileSystem.readFileString(configPath).pipe(
    Effect.map(grokDisabledPlugins),
    Effect.catchTags({
      PlatformError: (error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? new Set<string>() : undefined),
    }),
  );

  // A plugin without a readable manifest lists without a description.
  const readDescription = (installPath: string) =>
    Effect.forEach(MANIFEST_PATHS, (segments) =>
      fileSystem.readFileString(path.join(installPath, ...segments)).pipe(
        Effect.map((contents) => Option.getOrUndefined(decodeManifest(contents))?.description),
        Effect.orElseSucceed(() => undefined),
      ),
    ).pipe(Effect.map((descriptions) => descriptions.find((description) => description?.trim())));

  const catalog: ProviderPluginManagement["catalog"] = Effect.gen(function* () {
    const result = yield* run("list", ["plugin", "list", "--json", "--available"], LIST_TIMEOUT);
    if (result.code !== 0) return yield* failure("list", grokPluginFailureMessage(result));
    const entries = yield* decodePluginList(result.stdout).pipe(
      Effect.mapError((cause) => failure("list", undefined, cause)),
    );
    const disabled = yield* readDisabled;
    const descriptions = new Map<string, string>();
    yield* Effect.forEach(
      entries.filter((entry) => entry.status === "installed" && entry.path && !entry.description),
      (entry) =>
        readDescription(entry.path!).pipe(
          Effect.map((description) => {
            if (description) descriptions.set(pluginId(entry), description);
          }),
        ),
      { concurrency: 8, discard: true },
    );
    return grokPluginCatalog(
      entries,
      disabled ?? new Set(),
      descriptions,
      disabled ? [] : [UNREADABLE_CONFIG_WARNING],
    );
  });

  // Grok installs `name@marketplace` but finds an installed plugin by its name alone.
  const installedName = (id: string) => splitProviderPluginId(id).name;

  return {
    catalog,
    // Choosing Install in CodeShip is the trust Grok asks for before a plugin's hooks can run.
    install: (id) =>
      mutate("install", ["plugin", "install", id, "--trust"], FETCH_TIMEOUT).pipe(
        Effect.as({ appsNeedingAuth: [] }),
      ),
    // Keeping the plugin's saved data lets a reinstall pick up where it left off.
    uninstall: (id) =>
      mutate("uninstall", ["plugin", "uninstall", installedName(id), "--keep-data"]).pipe(
        Effect.asVoid,
      ),
    setEnabled: (id, enabled) =>
      mutate(enabled ? "enable" : "disable", [
        "plugin",
        enabled ? "enable" : "disable",
        installedName(id),
      ]).pipe(Effect.asVoid),
    addMarketplace: (source) =>
      mutate("addMarketplace", ["plugin", "marketplace", "add", source], FETCH_TIMEOUT).pipe(
        Effect.map((result) => ({
          marketplace: grokAddedMarketplaceName(result.stdout) ?? source,
        })),
      ),
  } satisfies ProviderPluginManagement;
});
