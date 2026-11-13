import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";

import { failoverText, runConditionInput, shownNoWorkSkip } from "./scheduledTaskRunCondition.ts";

describe("runConditionInput", () => {
  it.each([
    { name: "an empty command clears it", command: "  ", timeout: "60", expected: null },
    {
      name: "a blank timeout takes the default",
      command: " node check.mjs ",
      timeout: "",
      expected: { command: "node check.mjs", timeoutSeconds: 60 },
    },
    {
      name: "a timeout in range is kept",
      command: "node check.mjs",
      timeout: "600",
      expected: { command: "node check.mjs", timeoutSeconds: 600 },
    },
    {
      name: "a timeout over the limit blocks saving",
      command: "node check.mjs",
      timeout: "601",
      expected: undefined,
    },
    {
      name: "a timeout that is not a whole number blocks saving",
      command: "node check.mjs",
      timeout: "1.5",
      expected: undefined,
    },
    {
      name: "a command over the limit blocks saving",
      command: "x".repeat(2001),
      timeout: "60",
      expected: undefined,
    },
  ])("$name", ({ command, timeout, expected }) => {
    expect(runConditionInput({ command, timeoutSeconds: timeout })).toEqual(expected);
  });
});

describe("shownNoWorkSkip", () => {
  const skip = { at: "2026-11-11T12:00:00.000Z", scheduledFor: null, reason: "No open PRs" };

  it.each([
    { name: "a task that never ran", lastRunAt: null, expected: skip },
    { name: "a skip after the last run", lastRunAt: "2026-11-11T11:30:00.000Z", expected: skip },
    {
      name: "a run after the skip hides it",
      lastRunAt: "2026-11-11T12:30:00.000Z",
      expected: null,
    },
  ])("$name", ({ lastRunAt, expected }) => {
    expect(shownNoWorkSkip({ lastNoWorkSkip: skip, lastRunAt })).toEqual(expected);
  });
});

describe("failoverText", () => {
  const from = ProviderInstanceId.make("claude_main");
  const to = ProviderInstanceId.make("claude_spare");
  const names: Record<string, string> = { claude_main: "Main", claude_spare: "Spare" };
  const text = (extra: { reason?: string; mcpServers?: ReadonlyArray<string> }) =>
    failoverText({ from, to, ...extra }, (instanceId) => names[instanceId] ?? instanceId);

  it.each([
    {
      name: "a usage limit",
      extra: { reason: "usageLimit" },
      expected: "Started on Spare because Main was out of usage.",
    },
    {
      name: "a sign-out",
      extra: { reason: "signedOut" },
      expected: "Started on Spare because Main was signed out.",
    },
    {
      name: "an MCP sign-in",
      extra: { reason: "mcpSignIn", mcpServers: ["threadpage", "linear"] },
      expected: "Started on Spare because Main needs to sign in to threadpage, linear again.",
    },
    {
      name: "an MCP sign-in with no server names",
      extra: { reason: "mcpSignIn" },
      expected: "Started on Spare because Main needs to sign in to an MCP server again.",
    },
    {
      name: "a run recorded without a reason",
      extra: {},
      expected: "Started on Spare instead of Main.",
    },
    {
      name: "a reason a newer server added",
      extra: { reason: "other" },
      expected: "Started on Spare instead of Main.",
    },
  ])("says $name", ({ extra, expected }) => {
    expect(text(extra)).toBe(expected);
  });
});
