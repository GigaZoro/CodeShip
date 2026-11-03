import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import {
  orderProviderInstancesForFailover,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Pay-per-token instances bill every turn instead of drawing on a subscription.
const METERED_AUTH_TYPES = new Set(["apiKey", "api-key", "bedrock"]);

export interface AccountRoutingContext {
  readonly settings: Pick<
    ServerSettingsValue,
    "providerInstanceFailoverOrder" | "providerInstances" | "projectSettingsOverrides"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Accounts that stopped a run on a usage limit whose reset is still ahead. */
  readonly limitedInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly nowMs: number;
}

const usageExhausted = (provider: ServerProvider, nowMs: number) =>
  provider.usageLimits?.windows.some(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  ) === true;

/** The model this subscription account would run for `model` now, or null when it cannot take the turn. */
function modelWithRoom(
  provider: ServerProvider,
  input: AccountRoutingContext & { readonly projectId: ProjectId; readonly model: string },
): string | null {
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated" ||
    (provider.auth.type !== undefined && METERED_AUTH_TYPES.has(provider.auth.type)) ||
    !isProviderAvailable(provider) ||
    input.limitedInstanceIds.has(provider.instanceId) ||
    usageExhausted(provider, input.nowMs) ||
    !resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId)
  )
    return null;
  return resolveSelectableModel(provider.driver, input.model, provider.models);
}

/** Accounts of `driver` that can run `model` now, highest in the saved account order first. */
export function accountsWithRoom(
  input: AccountRoutingContext & {
    readonly driver: ProviderDriverKind;
    readonly projectId: ProjectId;
    readonly model: string;
  },
): ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly model: string }> {
  if (!supportsAccountFailover(input.driver)) return [];
  const eligible = input.providers.flatMap((provider) => {
    if (provider.driver !== input.driver) return [];
    const model = modelWithRoom(provider, input);
    return model === null ? [] : [{ instanceId: provider.instanceId, model }];
  });
  return orderProviderInstancesForFailover(input.settings.providerInstanceFailoverOrder, eligible);
}

/**
 * Where an auto-account selection runs. A thread stays on its account while that account has
 * room, so a switch never restarts its session needlessly. A new thread, or one whose account
 * ran out, takes the highest account in the order with room. With none left, it stays put.
 */
export function routeAutoAccount(
  input: AccountRoutingContext & {
    readonly selection: ModelSelection;
    readonly projectId: ProjectId;
    /** The account the thread already runs on; null for a thread with no run yet. */
    readonly currentInstanceId: ProviderInstanceId | null;
  },
): ModelSelection {
  const { selection } = input;
  if (selection.autoAccount !== true) return selection;
  const driver = input.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  )?.driver;
  if (driver === undefined) return selection;
  const current = input.providers.find(
    (provider) => provider.instanceId === input.currentInstanceId && provider.driver === driver,
  );
  const pickTarget = () => {
    if (current !== undefined) {
      const model = modelWithRoom(current, { ...input, model: selection.model });
      if (model !== null) return { instanceId: current.instanceId, model };
    }
    const withRoom = accountsWithRoom({ ...input, driver, model: selection.model })[0];
    if (withRoom !== undefined) return withRoom;
    return current === undefined
      ? undefined
      : { instanceId: current.instanceId, model: selection.model };
  };
  const target = pickTarget();
  return target === undefined ||
    (target.instanceId === selection.instanceId && target.model === selection.model)
    ? selection
    : { ...selection, instanceId: target.instanceId, model: target.model };
}

export class AccountRouting extends Context.Service<
  AccountRouting,
  {
    /** Resolves an auto-account selection to the account its next turn runs on. */
    readonly route: (input: {
      readonly selection: ModelSelection;
      readonly projectId: ProjectId;
      readonly currentInstanceId: ProviderInstanceId | null;
    }) => Effect.Effect<ModelSelection>;
  }
>()("t3/orchestration-v2/AccountRouting") {}

export const layer = Layer.effect(
  AccountRouting,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return {
      route: Effect.fn("AccountRouting.route")(
        function* (input) {
          if (input.selection.autoAccount !== true) return input.selection;
          const now = yield* DateTime.now;
          return routeAutoAccount({
            ...input,
            settings: yield* serverSettings.getSettings,
            providers: yield* providerRegistry.getProviders,
            limitedInstanceIds: yield* projections.getUsageLimitedProviderInstanceIds(now),
            nowMs: DateTime.toEpochMillis(now),
          });
        },
        // Routing only improves where a turn starts; the selected account still runs without it.
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.failed", { cause }).pipe(
                Effect.as(input.selection),
              ),
            ),
          ),
      ),
    };
  }),
);
