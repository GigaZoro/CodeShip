import type { autoCoordinatorInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import {
  autoModeModelFor,
  orderProviderInstancesForFailover,
} from "@t3tools/shared/serverSettings";
import { exhaustedModelUsageWindow } from "@t3tools/shared/usageLimits";
import { providerConstraints } from "../provider/providerConstraints.ts";
import { modelScopeHolds, modelWithRoom, type AccountRoutingContext } from "./AccountRouting.ts";

export function autoCoordinatorAccounts(
  input: AccountRoutingContext & {
    readonly driver: ProviderDriverKind;
    readonly projectId: ProjectId;
    readonly orchestrationCapableInstanceIds: ReadonlySet<ProviderInstanceId>;
  },
) {
  const other =
    input.driver === "claudeAgent" ? "codex" : input.driver === "codex" ? "claudeAgent" : undefined;
  return orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    input.providers,
  )
    .filter(
      (provider) =>
        provider.driver === other &&
        providerConstraints(
          provider,
          input.orchestrationCapableInstanceIds.has(provider.instanceId),
        ).length === 0,
    )
    .flatMap((provider) => {
      const models = provider.models.filter(
        (model) =>
          !model.isLegacy && modelWithRoom(provider, { ...input, model: model.slug }) !== null,
      );
      return models.length === 0 ? [] : [{ ...provider, models }];
    });
}

export function autoCoordinatorBriefInput(
  input: Parameters<typeof autoCoordinatorAccounts>[0] & { readonly selection: ModelSelection },
): Parameters<typeof autoCoordinatorInstructions>[0] {
  const others = autoCoordinatorAccounts(input);
  const own = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  const otherDriver = others[0]?.driver;
  const otherPrimary =
    otherDriver === undefined ? undefined : autoModeModelFor(input.settings, otherDriver);
  const reviewer =
    otherPrimary == null
      ? undefined
      : others.find(
          (provider) => modelWithRoom(provider, { ...input, model: otherPrimary.model }) !== null,
        );
  return {
    driver: input.driver,
    model: input.selection.model,
    primary: autoModeModelFor(input.settings, input.driver),
    ...(reviewer === undefined || otherPrimary == null
      ? {}
      : {
          otherPrimary: { ...otherPrimary, providerInstanceId: reviewer.instanceId },
        }),
    models:
      own?.models.filter(
        // An account-wide limit leaves these: the coordinator is running on this account now.
        (model) =>
          !model.isLegacy &&
          exhaustedModelUsageWindow(own, input.nowMs, model.slug) === undefined &&
          !modelScopeHolds(own, input, model.slug),
      ) ?? [],
    otherProviders: others.map((provider) => ({
      providerInstanceId: provider.instanceId,
      displayName: provider.displayName ?? provider.instanceId,
      driver: provider.driver,
      models: provider.models,
    })),
  };
}
