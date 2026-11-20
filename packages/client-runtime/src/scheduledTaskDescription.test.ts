import { describe, expect, it } from "vite-plus/test";

import { scheduledTaskDescriptionField, scheduledTaskPreview } from "./scheduledTaskDescription.ts";

describe("scheduled task description", () => {
  it("uses the prompt preview for tasks without a description", () => {
    const task = { prompt: "Check the queue and report failures" };
    expect(scheduledTaskPreview({ ...task, description: "Queue health" })).toBe("Queue health");
    expect(scheduledTaskPreview(task)).toBe(task.prompt);
    expect(scheduledTaskPreview({ ...task, description: null })).toBe(task.prompt);
  });

  it.each([
    {
      supported: true,
      savedDescription: "Queue health",
      description: "Queue health",
      expected: {},
    },
    {
      supported: true,
      savedDescription: "Queue health",
      description: "  ",
      expected: { description: null },
    },
    {
      supported: true,
      savedDescription: "",
      description: " Queue health ",
      expected: { description: "Queue health" },
    },
    { supported: false, savedDescription: "", description: "Queue health", expected: null },
    { supported: false, savedDescription: "", description: "", expected: {} },
  ])(
    "prepares the description change for a machine with description support $supported",
    ({ expected, ...input }) => {
      expect(scheduledTaskDescriptionField(input)).toEqual(expected);
    },
  );
});
