import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  providerUsageFields,
  type UsagePublication,
  usageReadingStale,
} from "./orchestratorUsage.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

function provider(
  driver: "claudeAgent" | "codex",
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:55:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const claudeLimits: ServerProviderUsageLimits = {
  checkedAt: "2026-09-03T11:55:00.000Z",
  accountKey: "07e998012c1137de",
  plan: "max",
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 40,
      windowDurationMins: 300,
      resetsAt: "2026-09-03T14:00:00.000Z",
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 70,
      windowDurationMins: 10080,
      resetsAt: "2026-09-06T00:00:00.000Z",
    },
    {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 100,
      windowDurationMins: 10080,
      model: "Fable",
      resetsAt: "2026-09-06T00:00:00.000Z",
    },
    // A spending cap: no window and no reset, so at 100% it holds nothing back.
    { id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: 100 },
  ],
  credits: { balance: "453.69", currency: "USD", unlimited: false },
};

const publish = (account: ServerProvider, publication: Partial<UsagePublication> = {}) =>
  providerUsageFields(account, {
    limited: false,
    redemptions: new Map(),
    credits: null,
    nowMs: now,
    maxWaitHours: 48,
    ...publication,
  });

describe("providerUsageFields", () => {
  it("publishes meters by stable id with the reset rule's decision for each limit", () => {
    expect(publish(provider("claudeAgent", { usageLimits: claudeLimits }))).toEqual({
      usage: {
        accountKey: "07e998012c1137de",
        plan: "max",
        measuredAt: "2026-09-03T11:55:00.000Z",
        meters: [
          {
            id: "session",
            model: null,
            usedPercent: 40,
            windowMinutes: 300,
            resetsAt: "2026-09-03T14:00:00.000Z",
            rateLimit: true,
          },
          {
            id: "weekly_all",
            model: null,
            usedPercent: 70,
            windowMinutes: 10080,
            resetsAt: "2026-09-06T00:00:00.000Z",
            rateLimit: true,
          },
          {
            id: "weekly_scoped:Fable",
            model: "Fable",
            usedPercent: 100,
            windowMinutes: 10080,
            resetsAt: "2026-09-06T00:00:00.000Z",
            rateLimit: true,
          },
          {
            id: "monthly_spend",
            model: null,
            usedPercent: 100,
            windowMinutes: null,
            resetsAt: null,
            rateLimit: false,
          },
        ],
        credits: { balance: "453.69", currency: "USD", unlimited: false },
        bankedResets: null,
        bankedResetsError: "not_read",
        usageAllowed: true,
        // The spent Fable week waits 60 hours, past the 48-hour wait, with no reset to claim.
        resetDecisions: [
          { model: null, action: "run", reason: "plan-available", until: null },
          {
            model: "Fable",
            action: "wait",
            reason: "no-reset",
            until: "2026-09-06T00:00:00.000Z",
          },
        ],
        lastRedemption: null,
      },
    });
  });

  it("publishes the last redemption only for the account the instance holds now", () => {
    const record = {
      at: "2026-09-03T11:00:00.000Z",
      outcome: "reset",
      kind: "full",
      reason: "reset-too-far",
    } as const;
    const redemptions = new Map([["07e998012c1137de", record]]);
    const held = (accountKey: string) =>
      publish(provider("claudeAgent", { usageLimits: { ...claudeLimits, accountKey } }), {
        redemptions,
      }).usage?.lastRedemption;
    expect(held("07e998012c1137de")).toEqual(record);
    expect(held("5d41402abc4b2a76")).toBeNull();
  });

  it("takes Codex's own usage answer and lists each banked reset without its id", () => {
    const fields = publish(
      provider("codex", {
        usageLimits: {
          checkedAt: "2026-09-03T11:55:00.000Z",
          windows: [],
          usageAllowed: false,
          resetCredits: {
            availableCount: 1,
            nextCreditId: "credit-1",
            credits: [
              {
                program: "codexRateLimits",
                kind: "full",
                status: "available",
                grantedAt: "2026-07-14T03:33:20.000Z",
                expiresAt: "2026-08-06T07:06:40.000Z",
              },
            ],
          },
        },
      }),
    );
    expect(fields.usage?.bankedResets).toEqual({
      available: 1,
      resets: [
        {
          status: "available",
          grantedAt: "2026-07-14T03:33:20.000Z",
          expiresAt: "2026-08-06T07:06:40.000Z",
          program: "codexRateLimits",
          kind: "full",
        },
      ],
    });
    expect(fields.usage?.usageAllowed).toBe(false);
    expect(JSON.stringify(fields)).not.toContain("credit-1");
  });

  it("lists Claude's grants and reset programs, and names a read that showed an unknown screen", () => {
    const resetPrograms = {
      granted: true,
      weeklySession: true,
      weeklySessionAvailableAt: "2026-09-08T00:00:00.000Z",
    };
    const fields = publish(
      provider("claudeAgent", {
        usageLimits: {
          ...claudeLimits,
          resetCredits: {
            availableCount: 2,
            nextExpiresAt: "2026-09-20T00:00:00.000Z",
            credits: [
              {
                program: "cedar_ember",
                kind: "weekly",
                resetsLeft: 2,
                expiresAt: "2026-09-20T00:00:00.000Z",
                usableNow: true,
                requiresLimit: true,
              },
              { program: "cedar_ember", kind: "fable", usableNow: false, requiresLimit: true },
            ],
          },
          resetPrograms,
        },
      }),
    );
    expect(fields.usage?.bankedResets).toEqual({
      available: 2,
      resets: [
        {
          status: null,
          grantedAt: null,
          expiresAt: "2026-09-20T00:00:00.000Z",
          program: "cedar_ember",
          kind: "weekly",
          resetsLeft: 2,
          usableNow: true,
          requiresLimit: true,
        },
        {
          status: null,
          grantedAt: null,
          expiresAt: null,
          program: "cedar_ember",
          kind: "fable",
          usableNow: false,
          requiresLimit: true,
        },
      ],
    });
    expect(fields.usage?.resetPrograms).toEqual(resetPrograms);
    const totalOnly = publish(
      provider("claudeAgent", {
        usageLimits: {
          ...claudeLimits,
          resetCredits: {
            availableCount: 0,
            credits: [
              {
                program: "cedar_ember",
                kindUnknownReason: "totalOnly",
                resetsLeft: 1,
                expiresAt: "2026-09-20T00:00:00.000Z",
                usableNow: false,
                paused: true,
              },
            ],
          },
          resetPrograms,
        },
      }),
    ).usage;
    expect(totalOnly?.bankedResets?.resets).toEqual([
      {
        status: null,
        grantedAt: null,
        expiresAt: "2026-09-20T00:00:00.000Z",
        program: "cedar_ember",
        kind: null,
        kindUnknownReason: "total_only",
        resetsLeft: 1,
        usableNow: false,
        paused: true,
      },
    ]);
    const unknown = publish(
      provider("claudeAgent", {
        usageLimits: {
          ...claudeLimits,
          resetCreditsError: "unrecognizedScreen",
          resetPrograms: { granted: true, weeklySession: false },
        },
      }),
    ).usage;
    expect(unknown).toMatchObject({
      bankedResets: null,
      bankedResetsError: "unrecognized_screen",
      resetPrograms: { granted: true, weeklySession: false, weeklySessionAvailableAt: null },
    });
    const noGrants = publish(
      provider("claudeAgent", {
        usageLimits: { ...claudeLimits, resetPrograms: { granted: false, weeklySession: false } },
      }),
    ).usage;
    expect(noGrants).toMatchObject({ bankedResets: { available: 0, resets: [] } });
    expect(noGrants).not.toHaveProperty("bankedResetsError");
  });

  it("withholds usage while the account is held, though its meters show room", () => {
    expect(
      publish(provider("claudeAgent", { usageLimits: claudeLimits }), { limited: true }).usage
        ?.usageAllowed,
    ).toBe(false);
  });

  it("decides on Codex's rate limits, not its monthly credit limit, at the server's wait", () => {
    const codex = provider("codex", {
      usageLimits: {
        checkedAt: "2026-09-03T11:55:00.000Z",
        accountKey: "5d41402abc4b2a76",
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 20,
            windowDurationMins: 300,
            resetsAt: "2026-09-03T15:00:00.000Z",
          },
          {
            id: "secondary",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 100,
            windowDurationMins: 10080,
            resetsAt: "2026-09-06T12:00:00.000Z",
          },
          // Codex states no window and no reset for it; a reset does not refill it.
          { id: "individual", kind: "monthly", label: "Monthly credit limit", usedPercent: 100 },
        ],
        usageAllowed: false,
        resetCredits: {
          availableCount: 1,
          credits: [
            {
              program: "codexRateLimits",
              kind: "full",
              status: "available",
              expiresAt: "2026-10-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const usage = publish(codex).usage;
    expect(usage?.meters.map(({ id, rateLimit }) => ({ id, rateLimit }))).toEqual([
      { id: "session", rateLimit: true },
      { id: "weekly_all", rateLimit: true },
      { id: "individual", rateLimit: false },
    ]);
    // The week resets in 72 hours, past the 48-hour wait, so the banked reset is claimed.
    expect(usage?.resetDecisions).toEqual([
      {
        model: null,
        action: "claim",
        reason: "reset-too-far",
        until: "2026-09-06T12:00:00.000Z",
        kind: "full",
      },
    ]);
    expect(publish(codex, { maxWaitHours: 72 }).usage?.resetDecisions).toEqual([
      {
        model: null,
        action: "wait",
        reason: "plan-resets-soon",
        until: "2026-09-06T12:00:00.000Z",
      },
    ]);
  });

  it.each([
    { credits: "spending", allowed: true },
    { credits: "not_enabled", allowed: false },
    { credits: "used_up", allowed: false },
  ] as const)(
    "allows a Codex account its plan refuses only while it is $credits prepaid credits",
    ({ credits, allowed }) => {
      const codex = provider("codex", {
        usageLimits: {
          checkedAt: "2026-09-03T11:55:00.000Z",
          windows: [],
          usageAllowed: false,
          credits: { balance: "25.00", unlimited: false },
        },
      });
      expect(publish(codex, { credits }).usage?.usageAllowed).toBe(allowed);
    },
  );

  it.each([
    ["signed out", { auth: { status: "unauthenticated" as const } }, "signed_out"],
    ["never read", {}, "not_read"],
    [
      "unsupported",
      {
        usageLimits: {
          checkedAt: "2026-09-03T11:55:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported" as const },
        },
      },
      "unsupported",
    ],
    [
      "failed with no last reading",
      {
        usageLimits: {
          checkedAt: "2026-09-03T11:55:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" as const, message: "Signed in as a@b.example" },
        },
      },
      "read_failed",
    ],
  ])(
    "publishes null usage with a code when %s, never the provider's text",
    (_, overrides, code) => {
      const fields = publish(provider("codex", overrides));
      expect(fields).toEqual({ usage: null, usageError: code });
    },
  );
});

describe("usageReadingStale", () => {
  const probedLongAgo = "2026-09-03T11:49:00.000Z";
  it.each([
    { name: "no reading", probedAt: probedLongAgo, stale: true },
    { name: "no reading from a probe a minute ago", probedAt: "2026-09-03T11:59:00.000Z" },
    {
      name: "a fresh reading",
      probedAt: probedLongAgo,
      usage: { checkedAt: "2026-09-03T11:51:00.000Z" },
    },
    {
      name: "an old reading",
      probedAt: probedLongAgo,
      usage: { checkedAt: "2026-09-03T11:49:00.000Z" },
      stale: true,
    },
    {
      name: "a fresh stream update over an old full read",
      probedAt: probedLongAgo,
      usage: { checkedAt: "2026-09-03T11:58:00.000Z", accountReadAt: "2026-09-03T11:49:00.000Z" },
      stale: true,
    },
  ])("reads again after ten minutes: $name", ({ probedAt, usage, stale = false }) => {
    const overrides = usage === undefined ? {} : { usageLimits: { ...usage, windows: [] } };
    expect(usageReadingStale(provider("codex", { checkedAt: probedAt, ...overrides }), now)).toBe(
      stale,
    );
  });
});
