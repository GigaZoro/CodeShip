import { useAtomValue } from "@effect/atom-react";

import { t, tn } from "~/i18n";
import { useServerConfigs } from "../../state/entities";
import { useManualSteps } from "../../state/manualSteps";
import { RailCountBadge } from "./SidebarNavRailBadge";
import {
  brokenProvidersAtom,
  failedScheduledTaskCountAtom,
  mcpProblemSummaryAtom,
  needsYouBreakdownAtom,
  pullRequestProblemsAtom,
} from "./sidebarNavRailAtoms";
import { manualStepsBadge, railNeedsYou, railProblems } from "./sidebarNavRailCounts";

export function useThreadsRailBadge() {
  const manualSteps = manualStepsBadge(useManualSteps().state?.view ?? null);
  const { count, breakdown, moneyDecisions } = railNeedsYou(
    useAtomValue(needsYouBreakdownAtom),
    manualSteps,
  );
  if (count === 0) return { label: t("Threads"), badge: null };
  const parts = [
    breakdown.failed > 0 && tn(breakdown.failed, "{count} failed", "{count} failed"),
    breakdown.limited > 0 && tn(breakdown.limited, "{count} usage limit", "{count} usage limits"),
    breakdown.approval > 0 && tn(breakdown.approval, "{count} approval", "{count} approvals"),
    breakdown.input > 0 && tn(breakdown.input, "{count} question", "{count} questions"),
    breakdown.request > 0 && tn(breakdown.request, "{count} request", "{count} requests"),
    moneyDecisions > 0 && tn(moneyDecisions, "{count} money decision", "{count} money decisions"),
  ].filter((part) => part !== false);
  return {
    label: tn(count, "Threads, {count} needs you: {parts}", "Threads, {count} need you: {parts}", {
      parts: parts.join(", "),
    }),
    badge: <RailCountBadge count={count} source="needs-you" />,
  };
}

export function useRailProblems() {
  const serverConfigs = useServerConfigs();
  return railProblems({
    providers: useAtomValue(brokenProvidersAtom),
    mcp: useAtomValue(mcpProblemSummaryAtom),
    manualSteps: manualStepsBadge(useManualSteps().state?.view ?? null),
    pullRequests: useAtomValue(pullRequestProblemsAtom),
    scheduledTaskFailures: useAtomValue(
      failedScheduledTaskCountAtom(JSON.stringify([...serverConfigs.keys()])),
    ),
  });
}
