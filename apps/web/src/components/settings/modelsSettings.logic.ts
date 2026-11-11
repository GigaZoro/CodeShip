import type { ServerProvider, ServerSettings } from "@t3tools/contracts";
import {
  orderProviderInstancesForFailover,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import { groupBy } from "effect/Array";

import { msg, type Message } from "~/i18n";

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
