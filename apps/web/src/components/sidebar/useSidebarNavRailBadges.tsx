import { useAtomValue } from "@effect/atom-react";
import { manualStepsFailureMessage } from "@t3tools/client-runtime/state/manualSteps";

import { t, tn } from "~/i18n";
import { useManualSteps } from "../../state/manualSteps";
import { RailCountBadge, RailDotBadge } from "./SidebarNavRailBadge";
import {
  brokenProvidersAtom,
  mcpProblemSummaryAtom,
  needsYouBreakdownAtom,
  pullRequestAttentionAtom,
} from "./sidebarNavRailAtoms";
import { manualStepsBadge } from "./sidebarNavRailCounts";

const MAX_NAMES = 3;

function namesList(names: ReadonlyArray<string>) {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return names.length > MAX_NAMES
    ? t("{names} +{count}", { names: shown, count: names.length - MAX_NAMES })
    : shown;
}

export function useThreadsRailBadge() {
  const breakdown = useAtomValue(needsYouBreakdownAtom);
  const count = Object.values(breakdown).reduce((total, n) => total + n, 0);
  if (count === 0) return { label: t("Threads"), badge: null };
  const parts = [
    breakdown.failed > 0 && tn(breakdown.failed, "{count} failed", "{count} failed"),
    breakdown.limited > 0 && tn(breakdown.limited, "{count} usage limit", "{count} usage limits"),
    breakdown.approval > 0 && tn(breakdown.approval, "{count} approval", "{count} approvals"),
    breakdown.input > 0 && tn(breakdown.input, "{count} question", "{count} questions"),
    breakdown.request > 0 && tn(breakdown.request, "{count} request", "{count} requests"),
  ].filter((part) => part !== false);
  return {
    label: tn(count, "Threads, {count} needs you: {parts}", "Threads, {count} need you: {parts}", {
      parts: parts.join(", "),
    }),
    badge: <RailCountBadge count={count} tone="attention" />,
  };
}

export function usePullRequestsRailBadge() {
  const attention = useAtomValue(pullRequestAttentionAtom);
  if (attention.count === 0) return { label: t("Pull requests"), badge: null };
  const parts = [
    attention.failingChecks > 0 &&
      tn(attention.failingChecks, "{count} failing check", "{count} failing checks"),
    attention.conflicts > 0 && tn(attention.conflicts, "{count} conflict", "{count} conflicts"),
    attention.changesRequested > 0 &&
      t("{count} changes requested", { count: attention.changesRequested }),
  ].filter((part) => part !== false);
  return {
    label: t("Pull requests: {parts}", { parts: parts.join(", ") }),
    badge: (
      <RailCountBadge
        count={attention.count}
        tone={attention.failingChecks + attention.conflicts > 0 ? "problem" : "neutral"}
      />
    ),
  };
}

export function useExtensionsRailBadge() {
  const { count, names } = useAtomValue(mcpProblemSummaryAtom);
  if (count === 0) return { label: t("Extensions"), badge: null };
  return {
    label: tn(
      count,
      "Extensions: {count} MCP server needs sign-in or failed when last checked: {names}",
      "Extensions: {count} MCP servers need sign-in or failed when last checked: {names}",
      { names: namesList(names) },
    ),
    badge: <RailCountBadge count={count} tone="problem" />,
  };
}

export function useManualStepsRailBadge() {
  const badge = manualStepsBadge(useManualSteps().state?.view ?? null);
  if (badge.kind === "failed") {
    return {
      label: t("Manual steps: {reason}", { reason: manualStepsFailureMessage(badge.reason) }),
      badge: <RailDotBadge />,
    };
  }
  if (badge.kind === "none") return { label: t("Manual steps"), badge: null };
  const label =
    badge.moneyDecisions > 0
      ? t("Manual steps: {count}, {money}", {
          count: badge.count,
          money: tn(badge.moneyDecisions, "{count} money decision", "{count} money decisions"),
        })
      : t("Manual steps: {count}", { count: badge.count });
  return {
    label,
    badge: (
      <RailCountBadge
        count={badge.count}
        tone={badge.moneyDecisions > 0 ? "attention" : "neutral"}
      />
    ),
  };
}

export function useSettingsRailBadge() {
  const broken = useAtomValue(brokenProvidersAtom);
  if (broken.length === 0) return { label: t("Settings"), badge: null };
  return {
    label: tn(
      broken.length,
      "Settings: {count} provider needs attention: {names}",
      "Settings: {count} providers need attention: {names}",
      {
        names: namesList(
          broken.map(({ name, environmentLabel }) => `${name} (${environmentLabel})`),
        ),
      },
    ),
    badge: <RailCountBadge count={broken.length} tone="problem" />,
  };
}
