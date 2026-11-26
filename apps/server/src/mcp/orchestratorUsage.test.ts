import {
  OrchestratorMcpUsageMeter,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { providerUsageFields, publishesUsage, usageReadingStale } from "./orchestratorUsage.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const decodeMeters = Schema.decodeUnknownSync(Schema.Array(OrchestratorMcpUsageMeter));

function provider(driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
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
  ],
  credits: { balance: "453.69", currency: "USD", unlimited: false },
};

describe("providerUsageFields", () => {
  it("publishes native quota IDs and scopes for a metered driver outside Claude and Codex", () => {
    const antigravity = provider("antigravity", {
      usageLimits: {
        checkedAt: claudeLimits.checkedAt,
        windows: [
          { ...claudeLimits.windows[1]!, id: "gemini-weekly", scope: "gemini-default" },
          { ...claudeLimits.windows[1]!, id: "gemini-argon-wtu-weekly", scope: "gemini-argon" },
          { ...claudeLimits.windows[1]!, id: "3p-weekly", scope: "third-party" },
        ],
      },
    });
    expect(publishesUsage(antigravity)).toBe(true);
    expect(providerUsageFields(antigravity, false).usage?.meters).toMatchObject([
      { id: "gemini-weekly", scope: "gemini-default" },
      { id: "gemini-argon-wtu-weekly", scope: "gemini-argon" },
      { id: "3p-weekly", scope: "third-party" },
    ]);
  });

  it("publishes a custom driver's reading when supplied and leaves empty readings unknown", () => {
    const custom = provider("example-adapter", {
      usageLimits: { checkedAt: claudeLimits.checkedAt, windows: [] },
    });
    expect(publishesUsage(custom)).toBe(true);
    expect(providerUsageFields(custom, false)).toEqual({ usage: null, usageError: "not_read" });
    const scope = { models: ["example/model-a", "example/model-b"] } as const;
    const observedAt = "2026-09-02T11:55:00.000Z";
    const window = { ...claudeLimits.windows[0]!, id: "shared-pool", scope, observedAt };
    const usage = providerUsageFields(
      { ...custom, usageLimits: { ...claudeLimits, windows: [window] } },
      false,
    ).usage;
    const meters = decodeMeters(usage?.meters);
    expect(meters).toMatchObject([{ id: "shared-pool", scope, observedAt }]);
  });

  it("publishes meters by stable id, and a spent scoped meter leaves the account's usage allowed", () => {
    expect(
      providerUsageFields(provider("claudeAgent", { usageLimits: claudeLimits }), false),
    ).toEqual({
      usage: {
        accountKey: "07e998012c1137de",
        plan: "max",
        measuredAt: "2026-09-03T11:55:00.000Z",
        meters: [
          {
            id: "session",
            nativeId: "five_hour",
            observedAt: claudeLimits.checkedAt,
            model: null,
            scope: "account",
            usedPercent: 40,
            windowMinutes: 300,
            resetsAt: "2026-09-03T14:00:00.000Z",
          },
          {
            id: "weekly_all",
            nativeId: "seven_day",
            observedAt: claudeLimits.checkedAt,
            model: null,
            scope: "account",
            usedPercent: 70,
            windowMinutes: 10080,
            resetsAt: "2026-09-06T00:00:00.000Z",
          },
          {
            id: "weekly_scoped:Fable",
            nativeId: "seven_day_fable",
            observedAt: claudeLimits.checkedAt,
            model: "Fable",
            scope: "model",
            usedPercent: 100,
            windowMinutes: 10080,
            resetsAt: "2026-09-06T00:00:00.000Z",
          },
        ],
        credits: { balance: "453.69", currency: "USD", unlimited: false },
        bankedResets: null,
        bankedResetsError: "not_read",
        usageAllowed: true,
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
      providerUsageFields(
        provider("claudeAgent", { usageLimits: { ...claudeLimits, accountKey } }),
        false,
        redemptions,
      ).usage?.lastRedemption;
    expect(held("07e998012c1137de")).toEqual(record);
    expect(held("5d41402abc4b2a76")).toBeNull();
  });

  it("takes Codex's own usage answer and lists each banked reset without its id", () => {
    const fields = providerUsageFields(
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
      false,
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
    const fields = providerUsageFields(
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
      false,
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
    const totalOnly = providerUsageFields(
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
      false,
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
    const unknown = providerUsageFields(
      provider("claudeAgent", {
        usageLimits: {
          ...claudeLimits,
          resetCreditsError: "unrecognizedScreen",
          resetPrograms: { granted: true, weeklySession: false },
        },
      }),
      false,
    ).usage;
    expect(unknown).toMatchObject({
      bankedResets: null,
      bankedResetsError: "unrecognized_screen",
      resetPrograms: { granted: true, weeklySession: false, weeklySessionAvailableAt: null },
    });
    const noGrants = providerUsageFields(
      provider("claudeAgent", {
        usageLimits: { ...claudeLimits, resetPrograms: { granted: false, weeklySession: false } },
      }),
      false,
    ).usage;
    expect(noGrants).toMatchObject({ bankedResets: { available: 0, resets: [] } });
    expect(noGrants).not.toHaveProperty("bankedResetsError");
  });

  it("withholds usage while the account is held, though its meters show room", () => {
    expect(
      providerUsageFields(provider("claudeAgent", { usageLimits: claudeLimits }), true).usage
        ?.usageAllowed,
    ).toBe(false);
  });

  it("keeps a spent Codex credit cap separate from ordinary plan usage", () => {
    const fields = providerUsageFields(
      provider("codex", {
        usageLimits: {
          checkedAt: claudeLimits.checkedAt,
          windows: [
            {
              id: "individual",
              label: "Monthly credit limit",
              kind: "monthly",
              usedPercent: 100,
            },
          ],
          usageAllowed: true,
          credits: { balance: "25.00", unlimited: false },
        },
      }),
      false,
      new Map(),
      "used_up",
    );
    expect(fields.usage).toMatchObject({
      meters: [{ id: "individual", scope: "spending-cap" }],
      credits: { balance: "25.00" },
      usageAllowed: true,
    });
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
      expect(providerUsageFields(codex, false, new Map(), credits).usage?.usageAllowed).toBe(
        allowed,
      );
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
      const fields = providerUsageFields(provider("codex", overrides), false);
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
    {
      name: "a fresh stream update retaining an older window",
      probedAt: probedLongAgo,
      usage: {
        checkedAt: "2026-09-03T11:58:00.000Z",
        windows: [{ ...claudeLimits.windows[1]!, observedAt: probedLongAgo }],
      },
      stale: true,
    },
  ])("reads again after ten minutes: $name", ({ probedAt, usage, stale = false }) => {
    const overrides = usage === undefined ? {} : { usageLimits: { windows: [], ...usage } };
    expect(usageReadingStale(provider("codex", { checkedAt: probedAt, ...overrides }), now)).toBe(
      stale,
    );
  });
});
