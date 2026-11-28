import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts/providerInstance";
import type { ServerProvider } from "@t3tools/contracts/server";
import { resolveProviderInstanceEnabled } from "@t3tools/contracts/settings";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * Local tools, such as a usage meter, read each enabled Claude account's folder from this file
 * instead of working it out again from the settings. `default` is Claude's own `~/.claude`, whose
 * account config is `~/.claude.json`; a folder set from a secret is listed without its path.
 */
const ClaudeAccountFolders = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(
    Schema.Union([
      Schema.Struct({
        instanceId: ProviderInstanceId,
        displayName: Schema.NullOr(Schema.String),
        status: Schema.Literal("available"),
        configFolder: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("default") }),
          Schema.Struct({ kind: Schema.Literal("path"), path: Schema.String }),
          Schema.Struct({ kind: Schema.Literal("secret") }),
        ]),
      }),
      Schema.Struct({
        instanceId: ProviderInstanceId,
        displayName: Schema.NullOr(Schema.String),
        status: Schema.Literal("unavailable"),
        reason: Schema.NullOr(Schema.String),
      }),
    ]),
  ),
});
type ClaudeAccountFolders = typeof ClaudeAccountFolders.Type;
type ClaudeAccount = ClaudeAccountFolders["accounts"][number];

const encodeClaudeAccountFolders = Schema.encodeSync(
  Schema.fromJsonString(ClaudeAccountFolders, { space: 2 }),
);

export const claudeAccountFoldersPath = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "providers", "claudeAgent", "accounts.json");

export const listClaudeAccounts = (input: {
  readonly configMap: ProviderInstanceConfigMap;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly unavailable: ReadonlyArray<ServerProvider>;
  readonly published: ReadonlyArray<ClaudeAccount>;
}): ClaudeAccountFolders => {
  const instances = new Map(input.instances.map((instance) => [instance.instanceId, instance]));
  const unavailable = new Map(input.unavailable.map((snapshot) => [snapshot.instanceId, snapshot]));
  const published = new Map(input.published.map((account) => [account.instanceId, account]));
  return {
    version: 1,
    accounts: Object.entries(input.configMap).flatMap<ClaudeAccount>(([rawInstanceId, entry]) => {
      const instanceId = ProviderInstanceId.make(rawInstanceId);
      const displayName = entry.displayName ?? null;
      const instance = instances.get(instanceId);
      if (instance !== undefined) {
        return instance.driverKind === CLAUDE_DRIVER &&
          instance.enabled &&
          instance.configFolder !== undefined
          ? [{ instanceId, displayName, status: "available", configFolder: instance.configFolder }]
          : [];
      }
      // An unavailable snapshot always reads as disabled, so the saved entry says whether it is on.
      if (entry.driver !== CLAUDE_DRIVER || !resolveProviderInstanceEnabled(entry)) return [];
      const snapshot = unavailable.get(instanceId);
      if (snapshot === undefined) {
        // The registry closes an instance before it builds the replacement, which can wait on a vault.
        const last = published.get(instanceId);
        return last === undefined ? [] : [last];
      }
      return [
        {
          instanceId,
          displayName,
          status: "unavailable",
          reason: snapshot.unavailableReason ?? null,
        },
      ];
    }),
  };
};

/** Writes the file at startup and whenever the instances or their settings change. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const serverSettings = yield* Settings.ServerSettingsService;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const filePath = claudeAccountFoldersPath(path, stateDir);
    let written: { readonly contents: string; readonly folders: ClaudeAccountFolders } | undefined;

    const publish = Effect.gen(function* () {
      const folders = listClaudeAccounts({
        configMap: deriveProviderInstanceConfigMap(yield* serverSettings.getSettings),
        instances: yield* registry.listInstances,
        unavailable: yield* registry.listUnavailable,
        published: written?.folders.accounts ?? [],
      });
      const contents = `${encodeClaudeAccountFolders(folders)}\n`;
      if (contents === written?.contents) return;
      yield* writeFileStringAtomically({ filePath, contents, mode: 0o600 });
      written = { contents, folders };
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("The Claude account folders were not published.", { filePath, error }),
      ),
    );

    const registryChanges = yield* registry.subscribeChanges;
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* publish;
    yield* Stream.merge(Stream.fromSubscription(registryChanges), settingsChanges).pipe(
      Stream.runForEach(() => publish),
      Effect.forkScoped,
    );
  }),
);
