import {
  defaultInstanceIdForDriver,
  ProviderSetupError,
  type ClaudeSettings,
  type CodexSettings,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

import { claudeAccountHomePath } from "./Drivers/ClaudeAccountHome.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { claudeKeychainService } from "./claudeLoginExpiry.ts";
import { codexAccountShadowHomePath } from "./CodexManagedHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

export const claudeBinding = Effect.fn("ProviderLoginHome.claudeBinding")(function* (
  config: ClaudeSettings,
  instanceId: ProviderInstanceId,
  stateDir: string,
  environment: NodeJS.ProcessEnv,
  hasConfigDirVariable: boolean,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const sharedHome = yield* resolveClaudeHomePath(config, environment);
  const accountHome =
    instanceId !== "claudeAgent" && !config.homePath.trim() && !hasConfigDirVariable
      ? claudeAccountHomePath(path, stateDir, instanceId)
      : undefined;
  const bindingHome = accountHome ?? sharedHome;
  const configuredHome =
    accountHome ??
    (config.homePath.trim() || environment.CLAUDE_CONFIG_DIR?.trim() ? sharedHome : undefined);
  const bindingKey =
    platform === "darwin"
      ? claudeKeychainService(configuredHome)
      : platform === "win32"
        ? bindingHome.toLowerCase()
        : bindingHome;
  return { sharedHome, accountHome, bindingHome, configuredHome, bindingKey };
});

export const codexBinding = Effect.fn("ProviderLoginHome.codexBinding")(function* (
  config: CodexSettings,
  instanceId: ProviderInstanceId,
  stateDir: string,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const envHome = environment.CODEX_HOME ?? "";
  const privateHome = codexAccountShadowHomePath(path, stateDir, instanceId);
  const layout = yield* resolveCodexHomeLayout(
    config.homePath.trim() || config.shadowHomePath.trim()
      ? config
      : config.privateLogin
        ? { ...config, homePath: envHome, shadowHomePath: privateHome }
        : envHome.trim()
          ? { ...config, homePath: envHome }
          : instanceId !== "codex"
            ? { ...config, shadowHomePath: privateHome }
            : config,
  );
  const home = layout.effectiveHomePath ?? layout.sharedHomePath;
  const bindingKey = `codex:home:${platform === "win32" ? home.toLowerCase() : home}`;
  return { layout, bindingKey };
});

export const location = Effect.fn("ProviderLoginHome.location")(function* (
  driver: ProviderDriverKind,
  bindingKey: string,
  generation: ClaudeSettings["loginGeneration"],
  stateDir: string,
) {
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const binding = yield* digest
    .digest(Digest.sha256, new TextEncoder().encode(bindingKey))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  const root = path.join(stateDir, "providers", driver, "sign-ins", binding);
  const activeHome = generation?.binding === binding ? path.join(root, generation.id) : undefined;
  return { binding, root, activeHome };
});

const isConfigObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isFlowId = Schema.is(Schema.String.check(Schema.isUUID(4)));

/** The CLI can refresh its own credentials mid-turn, so a process keeps its original home for life. */
export const make = Effect.fn("ProviderLoginHome.make")(function* (options: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly bindingKey: string;
  readonly generation: ClaudeSettings["loginGeneration"];
  readonly select?: (entry: ProviderInstanceConfig) => ProviderInstanceConfig;
  readonly discard?: (home: string) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const { stateDir } = yield* ServerConfig;
  const { root, binding, activeHome } = yield* location(
    options.driver,
    options.bindingKey,
    options.generation,
    stateDir,
  );
  const stage = Effect.fn("ProviderLoginHome.stage")(
    function* (id: string, instances: ReadonlyArray<ProviderInstanceId>) {
      if (!isFlowId(id))
        return yield* new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "start",
          detail: "Invalid provider sign-in identifier.",
        });
      const initial = yield* settings.withSettingsSnapshot(
        (current) => Effect.succeed(current.providerInstances),
        "stored",
      );
      const home = path.join(root, id);
      let published = false;
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      yield* Effect.acquireRelease(fs.makeDirectory(home, { mode: 0o700 }), () =>
        Effect.suspend(() =>
          published
            ? Effect.void
            : (options.discard?.(home) ?? Effect.void).pipe(
                Effect.ensuring(
                  fs.remove(home, { recursive: true }).pipe(Effect.ignoreCause({ log: true })),
                ),
              ),
        ),
      );
      const persist = settings
        .updateProviderInstance((current) => {
          const entryFor = (instanceId: ProviderInstanceId): ProviderInstanceConfig | undefined =>
            current.providerInstances[instanceId] ??
            (instanceId === defaultInstanceIdForDriver(options.driver)
              ? { driver: options.driver }
              : undefined);
          const stillBound = (id: ProviderInstanceId) => {
            const before = initial[id];
            const now = current.providerInstances[id];
            return (
              before?.driver === now?.driver &&
              Equal.equals(before?.config, now?.config) &&
              Equal.equals(before?.environment, now?.environment)
            );
          };
          if (
            entryFor(options.instanceId)?.driver !== options.driver ||
            instances.some((instanceId) => !stillBound(instanceId))
          )
            return undefined;
          return instances.flatMap((instanceId) => {
            const entry = entryFor(instanceId);
            if (!entry || entry.driver !== options.driver) return [];
            const selected =
              instanceId === options.instanceId && options.select ? options.select(entry) : entry;
            return [
              {
                operation: "upsert" as const,
                instanceId,
                instance: {
                  ...selected,
                  config: {
                    ...(isConfigObject(selected.config) ? selected.config : {}),
                    loginGeneration: { id, binding },
                  },
                },
              },
            ];
          });
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              published = true;
            }),
          ),
          Effect.asVoid,
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "save",
                detail: "Could not save the new provider sign-in. Try again.",
              }),
          ),
        );
      return { home, persist };
    },
    Effect.mapError(
      () =>
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "start",
          detail: "Could not prepare a private provider sign-in folder.",
        }),
    ),
  );
  return { activeHome, stage };
});
