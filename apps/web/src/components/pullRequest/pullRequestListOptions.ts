import { type Message, msg, t } from "~/i18n";
import type { PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";
import {
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  ClockIcon,
  EyeIcon,
  LayersIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PenLineIcon,
  UserLockIcon,
} from "lucide-react";

import type { PullRequestFilterOption } from "./PullRequestListFilters";
import type { PullRequestListSort } from "./pullRequestListPreferences";
import { PullRequestGlyph } from "./pullRequestIcons";

export const INVOLVEMENT_TABS = [
  { value: "all", label: msg("All"), Icon: LayersIcon },
  {
    value: "reviewing",
    label: msg("Reviewing"),
    Icon: EyeIcon,
  },
  {
    value: "authored",
    label: msg("Authored"),
    Icon: PenLineIcon,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

export const STATE_TABS = [
  { value: "all", label: msg("All"), Icon: LayersIcon },
  {
    value: "open",
    label: msg("Open"),
    Icon: PullRequestGlyph.pullRequest,
  },
  {
    value: "closed",
    label: msg("Closed"),
    Icon: PullRequestGlyph.closed,
  },
  {
    value: "merged",
    label: msg("Merged"),
    Icon: PullRequestGlyph.merged,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

export const SORT_OPTIONS = [
  { value: "ready", label: msg("Merge readiness"), Icon: ListChecksIcon },
  { value: "blocked", label: msg("Blocked on me"), Icon: UserLockIcon },
  { value: "updated", label: msg("Recently updated"), Icon: ClockIcon },
  { value: "newest", label: msg("Newest shown"), Icon: CalendarArrowDownIcon },
  { value: "oldest", label: msg("Oldest shown"), Icon: CalendarArrowUpIcon },
  { value: "largest", label: msg("Largest shown"), Icon: Maximize2Icon },
  { value: "smallest", label: msg("Smallest shown"), Icon: Minimize2Icon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListSort>>;

/** Static option tables hold `msg()` labels; components translate them when they render. */
export function resolveFilterOptions<Option extends { readonly label: Message }>(
  options: ReadonlyArray<Option>,
  resolve: typeof t,
): (Omit<Option, "label"> & { readonly label: string })[] {
  return options.map((option) => ({ ...option, label: resolve(option.label) }));
}
