import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";

import { msg, t, tn } from "../lib/i18n";
import type { AgentActivityProps, AgentActivityText } from "./AgentActivity";

// The widget only refreshes while the app is open, so after this long it stops
// claiming an agent is still working. Matches the Live Activity's stale date.
export const AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS = 10 * 60_000;

export type AgentActivityWidgetSource =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "snapshot"; readonly aggregate: RelayAgentActivityAggregateState | null };

function countTable(maxCount: number, format: (count: number) => string) {
  return Object.fromEntries(
    Array.from({ length: maxCount }, (_, index) => [String(index + 1), format(index + 1)]),
  );
}

/** Translated widget copy, with count tables for counts up to `maxCount`. */
export function agentActivityText(maxCount: number, resolve: typeof t = t): AgentActivityText {
  return {
    outOfDate: resolve(msg("Out of date")),
    failed: resolve(msg("Failed")),
    done: resolve(msg("Done")),
    workFailed: resolve(msg("Agent work failed")),
    workCompleted: resolve(msg("Agent work completed")),
    statusOutOfDate: resolve(msg("Agent status out of date")),
    approval: resolve(msg("Approval")),
    input: resolve(msg("Question")),
    noActiveAgents: resolve(msg("No active agents")),
    activeAgents: countTable(maxCount, (count) =>
      tn(count, "{count} active agent", "{count} active agents"),
    ),
    active: countTable(maxCount, (count) => tn(count, "{count} active", "{count} active")),
    needAttention: countTable(maxCount, (count) =>
      tn(count, "{count} needs attention", "{count} need attention"),
    ),
    needYou: countTable(maxCount, (count) => tn(count, "{count} needs you", "{count} need you")),
  };
}

export function agentActivityWidgetTimeline(
  source: AgentActivityWidgetSource,
  now: number,
  resolve: typeof t = t,
) {
  const updatedAt = new Date(now).toISOString();
  if (source.kind !== "snapshot" || !source.aggregate) {
    const props: AgentActivityProps = {
      text: agentActivityText(0, resolve),
      title: "T3.CodeShip",
      subtitle:
        source.kind === "signed-out"
          ? resolve(msg("Sign in to T3 Connect to see agents"))
          : source.kind === "unavailable"
            ? resolve(msg("Couldn't reach T3 Connect"))
            : source.kind === "loading"
              ? resolve(msg("Loading agents…"))
              : resolve(msg("No active agents")),
      activeCount: 0,
      updatedAt,
      activities: [],
    };
    return [{ date: new Date(now), props }];
  }

  const { aggregate } = source;
  const props: AgentActivityProps = {
    text: agentActivityText(Math.max(aggregate.activeCount, aggregate.activities.length), resolve),
    title: aggregate.title,
    subtitle: aggregate.subtitle,
    activeCount: aggregate.activeCount,
    updatedAt: aggregate.updatedAt,
    activities: aggregate.activities,
  };
  const hasInFlightRows = props.activities.some(
    (row) => row.phase !== "completed" && row.phase !== "failed",
  );
  if (!hasInFlightRows) {
    return [{ date: new Date(now), props }];
  }
  const staleProps: AgentActivityProps = {
    ...props,
    activities: props.activities.map((row) =>
      row.phase === "completed" || row.phase === "failed"
        ? row
        : { ...row, phase: "stale", status: resolve(msg("Out of date")) },
    ),
  };
  return [
    { date: new Date(now), props },
    { date: new Date(now + AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS), props: staleProps },
  ];
}
