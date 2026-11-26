import type { UsageSource } from "@t3tools/contracts";
import { msg, t, tn } from "./i18n.ts";

import {
  formatRelativeHourShort as formatRelativeHourShortWith,
  usageSourceMessages as usageSourceMessagesWith,
} from "./usageFormat.ts";
import type { UsageContractMismatch } from "./usageMerge.ts";

/** @public */
export function usageSourceMessages(
  sources: readonly UsageSource[],
  plural: typeof tn = tn,
): readonly string[] {
  return usageSourceMessagesWith(sources, (count) =>
    plural(
      count,
      "{count} malformed or inconsistent usage record was skipped; usage may be incomplete.",
      "{count} malformed or inconsistent usage records were skipped; usage may be incomplete.",
    ),
  );
}

/** @public */
export function formatUsageContractMismatch(
  environmentLabel: string,
  mismatch: Pick<UsageContractMismatch, "direction">,
  resolve: typeof t = t,
): string {
  return mismatch.direction === "serverBehind"
    ? resolve(msg("{environment} runs an older server version and is excluded from totals."), {
        environment: environmentLabel,
      })
    : resolve(
        msg(
          "This client is older than the server on {environment}; its usage is excluded from totals.",
        ),
        { environment: environmentLabel },
      );
}

/** @public */
export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
  hour12?: boolean,
  resolve: typeof t = t,
  locale?: string,
): string {
  return formatRelativeHourShortWith(
    hourStart,
    relativeTo,
    timeZone,
    hour12,
    (hour, daysAgo) =>
      daysAgo === 0
        ? resolve(msg("{hour} today"), { hour })
        : resolve(msg("{hour} yesterday"), { hour }),
    locale,
  );
}
