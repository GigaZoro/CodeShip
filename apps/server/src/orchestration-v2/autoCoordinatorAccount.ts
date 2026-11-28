import type { autoCoordinatorInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  isProviderInstanceBackgroundAllowed,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProjectId,
} from "@t3tools/contracts";
import { createModelSelection, offeredOptionSelections } from "@t3tools/shared/model";
import {
  autoModeModelFor,
  firstByRank,
  orderProviderInstancesForFailover,
  quotaAwareAutoProfiles,
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

/** Accounts that can run a delegated task, in failover order. */
function runnableAccounts(input: AutoCoordinatorContext) {
  return orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    input.providers,
  ).filter(
    (provider) =>
      isProviderInstanceBackgroundAllowed(input.settings, provider.instanceId) &&
      providerConstraints(provider, input.orchestrationCapableInstanceIds.has(provider.instanceId))
        .length === 0,
  );
}

/** `driver`'s accounts that can run a delegated task, in failover order. */
function delegateAccounts(input: AutoCoordinatorContext, driver: ProviderDriverKind) {
  return runnableAccounts(input).filter((provider) => provider.driver === driver);
}

/** Other providers' accounts that can run a delegated task, paired provider first, then failover order. */
function otherDelegateAccounts(input: AutoCoordinatorContext) {
  const paired = otherDriverOf(input.driver);
  const eligible = runnableAccounts(input).filter((provider) => provider.driver !== input.driver);
  return paired === undefined
    ? eligible
    : [
        ...eligible.filter((provider) => provider.driver === paired),
        ...eligible.filter((provider) => provider.driver !== paired),
      ];
}

/** Other providers' accounts a delegate can run on now, each with its current models that have room. */
export function autoCoordinatorAccounts(input: AutoCoordinatorContext) {
  return otherDelegateAccounts(input).flatMap((provider) => {
    const models = provider.models.filter(
      (model) =>
        !model.isLegacy && modelWithRoom(provider, { ...input, model: model.slug }) !== null,
    );
    return models.length === 0 ? [] : [{ ...provider, models }];
  });
}

/**
 * `driver`'s reviewer on its first account with room: its Settings primary, even if legacy. An
 * unsaved default the catalog lists only as an alias (Antigravity's `antigravity-default`) stands
 * for the session's current model, so those accounts review on their Auto profile instead.
 */
function reviewerOn(input: AutoCoordinatorContext, driver: ProviderDriverKind) {
  const saved = input.settings.autoModeModels[driver] !== undefined;
  const primary = autoModeModelFor(input.settings, driver);
  // The primary ranks with an account's best profile, so failover order decides between them.
  const choice = firstByRank(
    delegateAccounts(input, driver).map((account) =>
      primary !== null &&
      (saved || account.models.some((candidate) => candidate.slug === primary.model))
        ? [
            () => {
              // The account's own id: delegate_task rejects a display name it does not list.
              const model = modelWithRoom(account, { ...input, model: primary.model });
              return model === null
                ? null
                : createModelSelection(
                    account.instanceId,
                    model,
                    offeredOptionSelections(
                      account.models.find((candidate) => candidate.slug === model)?.capabilities
                        ?.optionDescriptors,
                      primary.options,
                    ),
                  );
            },
          ]
        : quotaAwareAutoProfiles(
            account,
            (slug) => modelWithRoom(account, { ...input, model: slug }) !== null,
          ),
    ),
  );
  return choice === null
    ? undefined
    : {
        model: choice.model,
        providerInstanceId: choice.instanceId,
        options: choice.options ?? [],
      };
}

export function autoCoordinatorBriefInput(
  input: AutoCoordinatorContext & { readonly selection: ModelSelection },
): Parameters<typeof autoCoordinatorInstructions>[0] {
  const others = autoCoordinatorAccounts(input);
  const own = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  // The paired provider reviews first; any other enabled provider covers it when it cannot run.
  const paired = otherDriverOf(input.driver);
  const reviewDrivers = new Set([
    ...(paired === undefined ? [] : [paired]),
    ...otherDelegateAccounts(input).map((provider) => provider.driver),
  ]);
  const otherReviewer = [...reviewDrivers]
    .map((driver) => reviewerOn(input, driver))
    .find((reviewer) => reviewer !== undefined);
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
