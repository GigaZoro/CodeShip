import { EnvironmentId, type LinkedScheduledTaskMachine } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickLinkedMachineTasks } from "./linkedScheduledTasks.ts";

const MAC = EnvironmentId.make("mac");
const LAPTOP = EnvironmentId.make("laptop");
const PC = EnvironmentId.make("pc");
const SERVER = EnvironmentId.make("server");

const machine = (
  environmentId: EnvironmentId,
  label: string,
  seenAt: string | null,
  checkedAt = "2026-11-07T15:00:00.000Z",
): LinkedScheduledTaskMachine => ({
  environmentId,
  label,
  seenAt,
  checkedAt,
  error: null,
  tasks: [],
});

describe("pickLinkedMachineTasks", () => {
  it.each([
    {
      name: "takes the list from the machine that heard from it last",
      lists: [
        { environmentId: MAC, machines: [machine(PC, "Zoro-PC", "2026-11-07T14:00:00.000Z")] },
        { environmentId: LAPTOP, machines: [machine(PC, "Zoro-PC", "2026-11-07T14:30:00.000Z")] },
      ],
      readsLive: [],
      expected: [{ label: "Zoro-PC", via: LAPTOP }],
    },
    {
      name: "breaks a tie on when each machine last asked",
      lists: [
        {
          environmentId: MAC,
          machines: [machine(PC, "Zoro-PC", null, "2026-11-07T15:05:00.000Z")],
        },
        { environmentId: LAPTOP, machines: [machine(PC, "Zoro-PC", null)] },
      ],
      readsLive: [],
      expected: [{ label: "Zoro-PC", via: MAC }],
    },
    {
      name: "leaves out machines the client reads live and sorts the rest by name",
      lists: [
        {
          environmentId: MAC,
          machines: [
            machine(PC, "Zoro-PC", null),
            machine(SERVER, "Build server", null),
            machine(LAPTOP, "Laptop", null),
          ],
        },
      ],
      readsLive: [LAPTOP],
      expected: [
        { label: "Build server", via: MAC },
        { label: "Zoro-PC", via: MAC },
      ],
    },
  ])("$name", ({ lists, readsLive, expected }) => {
    const picked = pickLinkedMachineTasks({
      lists,
      readsLive: (environmentId) => readsLive.includes(environmentId),
    });
    expect(picked.map(({ machine: { label }, via }) => ({ label, via }))).toEqual(expected);
  });
});
