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

import type { PullRequestFilterOptionSource } from "./PullRequestListFilters";
import type { PullRequestListSort } from "./pullRequestListPreferences";
import { PullRequestGlyph } from "./pullRequestIcons";
import { msg } from "~/i18n";

export const INVOLVEMENT_TABS = [
  { value: "all", label: msg("All"), Icon: LayersIcon },
  { value: "reviewing", label: msg("Reviewing"), Icon: EyeIcon },
  { value: "authored", label: msg("Authored"), Icon: PenLineIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOptionSource<PullRequestInvolvement>>;

export const STATE_TABS = [
  { value: "all", label: msg("All"), Icon: LayersIcon },
  { value: "open", label: msg("Open"), Icon: PullRequestGlyph.pullRequest },
  { value: "closed", label: msg("Closed"), Icon: PullRequestGlyph.closed },
  { value: "merged", label: msg("Merged"), Icon: PullRequestGlyph.merged },
] as const satisfies ReadonlyArray<PullRequestFilterOptionSource<PullRequestListState>>;

export const SORT_OPTIONS = [
  { value: "ready", label: msg("Merge readiness"), Icon: ListChecksIcon },
  { value: "blocked", label: msg("Blocked on me"), Icon: UserLockIcon },
  { value: "updated", label: msg("Recently updated"), Icon: ClockIcon },
  { value: "newest", label: msg("Newest shown"), Icon: CalendarArrowDownIcon },
  { value: "oldest", label: msg("Oldest shown"), Icon: CalendarArrowUpIcon },
  { value: "largest", label: msg("Largest shown"), Icon: Maximize2Icon },
  { value: "smallest", label: msg("Smallest shown"), Icon: Minimize2Icon },
] as const satisfies ReadonlyArray<PullRequestFilterOptionSource<PullRequestListSort>>;
