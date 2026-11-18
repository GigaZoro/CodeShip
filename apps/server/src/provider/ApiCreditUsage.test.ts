import { it, expect } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderApiCredit,
} from "@t3tools/contracts";
import { apiCreditUsageRows } from "./ApiCreditUsage.ts";

it("joins API accounts by plan identity and retains unlinked plans with known grants", () => {
  const provider = (id: string, plan?: string): ServerProvider => ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-19T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(plan ? { usageLimits: { checkedAt: "2026-11-19T00:00:00.000Z", plan, windows: [] } } : {}),
  });
  const plans = [
    provider("one", "max"),
    provider("two", "claude_max_20x_subscription"),
    provider("team", "team"),
  ];
  const api = { ...provider("api"), billingKind: "payPerUse" as const };
  const credit: ServerProviderApiCredit = {
    linkedPlanInstanceId: plans[1]!.instanceId,
    grantUsd: 200,
    cycleStart: "2026-11-01T00:00:00.000Z",
    cycleEnd: "2026-12-01T00:00:00.000Z",
    balanceState: "available",
    checkedAt: api.checkedAt,
    meteringStartedAt: api.checkedAt,
    spendUsd: 2,
    estimatedRemainingUsd: 198,
    spendSource: "metered",
    unpricedUsage: false,
  };
  const rows = apiCreditUsageRows([...plans, api], new Map([[api.instanceId, credit]]));
  expect(
    rows.map((row) => [row.planInstanceId, row.suggestedGrantUsd, row.apiAccounts.length]),
  ).toEqual([
    ["one", 100, 0],
    ["two", 200, 1],
    ["team", null, 0],
  ]);
  expect(rows[1]?.apiAccounts[0]?.credit).toEqual(credit);
});
