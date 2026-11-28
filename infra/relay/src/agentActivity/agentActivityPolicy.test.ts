import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts/baseSchemas";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import { isAlertTrigger, shouldAlertForActivity } from "./agentActivityAlerts.ts";

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  headline: "Working",
  phase: "running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const aggregate = (states: RelayAgentActivityState[]) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

describe("shared agent activity policy", () => {
  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "keeps an older %s ahead of five running rows",
    (phase) => {
      const running = Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const waiting = { ...state, phase, updatedAt: "1969-12-31T23:59:00.000Z" };
      const next = aggregate([...running, waiting]);
      expect(next.activities[0]?.threadId).toBe(state.threadId);
      expect(next.activeCount).toBe(6);
      expect(next.activities).toHaveLength(5);
    },
  );

  const at = (minute: number) => `1970-01-01T00:0${minute}:00.000Z`;
  it.each([
    [
      "a rename after completion",
      { phase: "completed", occurredAt: at(1) },
      "completed",
      at(1),
      false,
    ],
    [
      "a repeated request",
      { phase: "waiting_for_input", occurredAt: at(1) },
      "waiting_for_input",
      at(1),
      false,
    ],
    ["a second completion", { phase: "completed", occurredAt: at(1) }, "completed", at(2), true],
    [
      "a new request",
      { phase: "waiting_for_input", occurredAt: at(1) },
      "waiting_for_input",
      at(2),
      true,
    ],
    [
      "completion after a request",
      { phase: "waiting_for_input", occurredAt: at(1) },
      "completed",
      at(1),
      true,
    ],
    ["completion after running", { phase: "running", occurredAt: null }, "completed", at(1), true],
    [
      "the retry of a completion whose alert was never queued",
      { phase: "completed", occurredAt: at(1), alertUnsent: true },
      "completed",
      at(1),
      true,
    ],
    ["completion with no stored row", null, "completed", at(1), true],
    ["running", { phase: "completed", occurredAt: at(1) }, "running", undefined, false],
  ] as const)("treats %s by its occurrence", (_name, previous, phase, occurredAt, expected) => {
    expect(isAlertTrigger(previous, { phase, occurredAt })).toBe(expected);
  });

  it.each([
    ["completed", { phase: "running", occurredAt: null }, true],
    ["completed", { phase: "failed", occurredAt: null }, false],
    ["completed", { phase: "completed", occurredAt: at(1) }, false],
    ["completed", null, false],
    ["waiting_for_input", { phase: "waiting_for_approval", occurredAt: null }, false],
    ["waiting_for_input", { phase: "completed", occurredAt: null }, true],
    ["waiting_for_input", null, true],
    ["running", null, false],
  ] as const)(
    "falls back to the phase class for %s without an occurrence (stored: %o)",
    (phase, previous, expected) => {
      expect(isAlertTrigger(previous, { phase })).toBe(expected);
    },
  );

  it("checks current permission, event preferences, and freshness together", () => {
    const input = { ...state, phase: "completed" as const, preferences, nowMs: 0 };
    expect(shouldAlertForActivity(input)).toBe(true);
    expect(
      shouldAlertForActivity({
        ...input,
        notificationLevel: "following",
        preferences: { ...preferences, notificationsEnabled: false },
      }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(false);
    expect(shouldAlertForActivity({ ...input, notificationLevel: "muted" })).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        notificationLevel: "following",
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(true);
    expect(shouldAlertForActivity({ ...input, nowMs: 180_000 })).toBe(false);
    expect(
      shouldAlertForActivity({ ...input, notificationLevel: "following", nowMs: 180_000 }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        occurredAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:03:00.000Z",
        nowMs: 180_000,
      }),
    ).toBe(false);
  });
});
