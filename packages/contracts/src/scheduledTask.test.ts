import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MAX_SCHEDULED_TASK_DESCRIPTION_LENGTH,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskDescription,
  ScheduledTaskSchedule,
  ScheduledTaskSharedCopy,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeUpsertInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const decodeSharedCopy = Schema.decodeUnknownSync(ScheduledTaskSharedCopy);

describe("ScheduledTaskDescription", () => {
  const decode = Schema.decodeUnknownSync(ScheduledTaskDescription);

  it("trims the description before checking its length", () => {
    const longest = "x".repeat(MAX_SCHEDULED_TASK_DESCRIPTION_LENGTH);
    expect(decode(`  ${longest}\n`)).toBe(longest);
    expect(() => decode(`${longest}x`)).toThrow();
    expect(() => decode("  \n")).toThrow();
  });
});

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

describe("ScheduledTask routingConstraints", () => {
  const baseUpsert = {
    title: "Nightly audit",
    prompt: "Check the tree",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: "project-1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", autoAccount: true },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
  };
  const baseTask = {
    ...baseUpsert,
    id: "task-1",
    createdAt: "2026-11-28T00:00:00.000Z",
    updatedAt: "2026-11-28T00:00:00.000Z",
    nextRunAt: "2026-11-28T00:01:00.000Z",
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  const baseShared = {
    id: "task-1",
    title: "Nightly audit",
    prompt: "Check the tree",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    workspaceStrategy: { type: "root" },
    modelSelection: baseUpsert.modelSelection,
    followsDefaultModel: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-11-28T00:00:00.000Z",
    shared: {
      revision: { at: "2026-11-28T00:00:00.000Z", environmentId: "env-a" },
      project: { type: "none" },
      excludedEnvironmentIds: [],
    },
  };

  it("decodes omitted, null, single, and array routingConstraints across scheduled task contracts", () => {
    expect(decodeUpsertInput(baseUpsert).routingConstraints).toBeUndefined();
    expect(decodeTask(baseTask).routingConstraints).toBeUndefined();
    expect(decodeSharedCopy(baseShared).routingConstraints).toBeUndefined();

    expect(
      decodeUpsertInput({ ...baseUpsert, routingConstraints: null }).routingConstraints,
    ).toBeNull();
    expect(decodeTask({ ...baseTask, routingConstraints: null }).routingConstraints).toBeNull();
    expect(
      decodeSharedCopy({ ...baseShared, routingConstraints: null }).routingConstraints,
    ).toBeNull();

    const single = {
      capabilityTier: "deep",
      minTier: "standard",
      excludeVendorFamily: "anthropic",
    };
    expect(
      decodeUpsertInput({ ...baseUpsert, routingConstraints: single }).routingConstraints,
    ).toEqual(single);
    expect(decodeTask({ ...baseTask, routingConstraints: single }).routingConstraints).toEqual(
      single,
    );
    expect(
      decodeSharedCopy({ ...baseShared, routingConstraints: single }).routingConstraints,
    ).toEqual(single);

    const multi = {
      minTier: "frontier",
      excludeVendorFamily: ["anthropic", "openai"],
    };
    expect(
      decodeUpsertInput({ ...baseUpsert, routingConstraints: multi }).routingConstraints,
    ).toEqual(multi);
    expect(() =>
      decodeUpsertInput({ ...baseUpsert, routingConstraints: { capabilityTier: "ultra" } }),
    ).toThrow();
    expect(() => decodeTask({ ...baseTask, routingConstraints: { minTier: "ultra" } })).toThrow();
  });
});
