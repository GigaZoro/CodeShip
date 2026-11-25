import type { autoCoordinatorInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProjectId,
} from "@t3tools/contracts";
import { offeredOptionSelections } from "@t3tools/shared/model";
import {
  autoModeModelFor,
  orderProviderInstancesForFailover,
} from "@t3tools/shared/serverSettings";
import { exhaustedModelUsageWindow } from "@t3tools/shared/usageLimits";
import { providerConstraints } from "../provider/providerConstraints.ts";
import { modelScopeHolds, modelWithRoom, type AccountRoutingContext } from "./AccountRouting.ts";

type AutoCoordinatorContext = AccountRoutingContext & {
  readonly driver: ProviderDriverKind;
  readonly projectId: ProjectId;
  readonly orchestrationCapableInstanceIds: ReadonlySet<ProviderInstanceId>;
};

function otherDriverOf(driver: ProviderDriverKind) {
  return driver === "claudeAgent"
    ? ProviderDriverKind.make("codex")
    : driver === "codex"
      ? ProviderDriverKind.make("claudeAgent")
      : undefined;
}

/** `driver`'s accounts that can run a delegated task, in failover order. */
function delegateAccounts(input: AutoCoordinatorContext, driver: ProviderDriverKind) {
  return orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    input.providers,
  ).filter(
    (provider) =>
      provider.driver === driver &&
      providerConstraints(provider, input.orchestrationCapableInstanceIds.has(provider.instanceId))
        .length === 0,
  );
}

/** The other provider's accounts a delegate can run on now, each with its current models that have room. */
export function autoCoordinatorAccounts(input: AutoCoordinatorContext) {
  const other = otherDriverOf(input.driver);
  return (other === undefined ? [] : delegateAccounts(input, other)).flatMap((provider) => {
    const models = provider.models.filter(
      (model) =>
        !model.isLegacy && modelWithRoom(provider, { ...input, model: model.slug }) !== null,
    );
    return models.length === 0 ? [] : [{ ...provider, models }];
  });
}

/**
 * `driver`'s Settings primary on its first account with room for it, as a review target. The
 * primary is the user's choice, so a model its catalog marks legacy still counts.
 */
function reviewerOn(input: AutoCoordinatorContext, driver: ProviderDriverKind | undefined) {
  const primary = driver === undefined ? null : autoModeModelFor(input.settings, driver);
  if (driver === undefined || primary === null) return undefined;
  for (const account of delegateAccounts(input, driver)) {
    // The account's own id for the model: delegate_task rejects a display name it does not list.
    const model = modelWithRoom(account, { ...input, model: primary.model });
    if (model === null) continue;
    return {
      model,
      providerInstanceId: account.instanceId,
      options: offeredOptionSelections(
        account.models.find((candidate) => candidate.slug === model)?.capabilities
          ?.optionDescriptors,
        primary.options,
      ),
    };
  }
  return undefined;
}

export function autoCoordinatorBriefInput(
  input: AutoCoordinatorContext & { readonly selection: ModelSelection },
): Parameters<typeof autoCoordinatorInstructions>[0] {
  const others = autoCoordinatorAccounts(input);
  const own = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  const otherReviewer = reviewerOn(input, otherDriverOf(input.driver));
  const ownReviewer = reviewerOn(input, input.driver);
  return {
    driver: input.driver,
    model: input.selection.model,
    primary: autoModeModelFor(input.settings, input.driver),
    ...(otherReviewer === undefined ? {} : { otherReviewer }),
    ...(ownReviewer === undefined ? {} : { ownReviewer }),
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
