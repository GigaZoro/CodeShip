import type { ServerProvider, ServerSettings } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  canAccountRun,
  orderProviderInstancesForFailover,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import { dedupeWith, groupBy } from "effect/Array";

import { msg, type Message } from "~/i18n";
import { getAppModelOptionsForInstance, type AppModelOption } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "~/providerInstances";

/** Roles whose model another role can inherit while it is unset. */
type InheritedModelRole = "default" | "titles" | "writing";

export interface ModelInheritance {
  readonly from: InheritedModelRole;
  readonly label: Message;
}

const INHERITANCE_LABELS: Record<InheritedModelRole, Message> = {
  default: msg("Same as default"),
  titles: msg("Same as titles"),
  writing: msg("Same as writing"),
};

const inherits = (from: InheritedModelRole): ModelInheritance => ({
  from,
  label: INHERITANCE_LABELS[from],
});

/** An unset scheduled tasks model runs the model new threads start on. */
export function scheduledTaskModelInheritance(
  settings: Pick<ServerSettings, "scheduledTaskModelSelection">,
): ModelInheritance | null {
  return settings.scheduledTaskModelSelection === null ? inherits("default") : null;
}

/** An unset commit and pull request writer runs the titles model. */
export function sourceControlWriterModelInheritance(
  settings: Pick<ServerSettings, "sourceControlWriterModelSelection">,
): ModelInheritance | null {
  return settings.sourceControlWriterModelSelection === null ? inherits("titles") : null;
}

/** An unset review guide model runs the writer, which itself runs the titles model while unset. */
export function reviewGuideModelInheritance(
  settings: Pick<ServerSettings, "reviewGuideModelSelection" | "sourceControlWriterModelSelection">,
): ModelInheritance | null {
  if (settings.reviewGuideModelSelection !== null) return null;
  return inherits(settings.sourceControlWriterModelSelection === null ? "titles" : "writing");
}

/** Drivers that switch accounts at limits, each with its enabled accounts in the order tried. */
export function accountGroups(
  order: ServerSettings["providerInstanceFailoverOrder"],
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ReadonlyArray<ServerProvider>> {
  const accountsByDriver = groupBy(
    providers.filter((provider) => provider.enabled && supportsAccountFailover(provider.driver)),
    (provider) => provider.driver,
  );
  return Object.values(accountsByDriver).map((accounts) =>
    orderProviderInstancesForFailover(order, accounts),
  );
}

export interface AutoModeModelChoices {
  readonly entry: ProviderInstanceEntry;
  readonly options: ReadonlyArray<AppModelOption>;
}

/**
 * Auto's model choices for one provider's accounts, in the order tried: what each account Auto can
 * run on this machine offers under its own model settings, as one entry, since Auto runs each turn
 * on an account that has the model.
 */
export function autoModeModelChoices(
  accounts: ReadonlyArray<ServerProvider>,
  settings: UnifiedSettings,
): AutoModeModelChoices {
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(accounts),
    settings,
    null,
  );
  const runnable = entries.filter((entry) => canAccountRun(entry.snapshot, settings, null));
  const sources = runnable.length > 0 ? runnable : entries.slice(0, 1);
  const sameSlug = (left: { slug: string }, right: { slug: string }) => left.slug === right.slug;
  return {
    entry: {
      ...(sources.find((entry) => entry.status === "ready") ??
        sources.find(isProviderInstancePickerReady) ??
        sources[0]!),
      // The picker lists only a ready entry's models, and Auto also runs on an account whose
      // check only warned.
      ...(runnable.length > 0 ? { status: "ready" as const } : {}),
      models: dedupeWith(
        sources.flatMap((entry) => entry.models),
        sameSlug,
      ),
    },
    options: dedupeWith(
      sources.flatMap((entry) => getAppModelOptionsForInstance(settings, entry)),
      sameSlug,
    ),
  };
}
