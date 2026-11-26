import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  chatGptSharingLimitReading,
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  codexRateLimitsToUpdate,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("codexRateLimitsToLimits", () => {
  it("shows an Enterprise monthly credit allowance in reads and notifications without a duration", () => {
    const snapshot = {
      limitId: "codex",
      planType: "enterprise_cbp_usage_based",
      primary: null,
      secondary: null,
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
    };
    const windows = [
      {
        id: "individual",
        scope: "spending-cap",
        kind: "monthly",
        label: "Monthly credit limit",
        usedPercent: 1,
        resetsAt: "2026-07-19T22:26:40.000Z",
      },
    ];

    expect(
      codexRateLimitsToLimits({
        checkedAt,
        read: { rateLimits: { limitId: "spark" }, rateLimitsByLimitId: { codex: snapshot } },
      }),
    ).toEqual({ checkedAt, plan: "enterprise_cbp_usage_based", windows });
    expect(codexRateLimitsToUpdate(snapshot)).toEqual({ windows });
  });

  it("maps primary and secondary onto the session and weekly windows", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        read: {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 12, resetsAt: 1_784_000_000, windowDurationMins: 300 },
            secondary: { usedPercent: 47, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
          },
        },
      }),
    ).toEqual({
      checkedAt,
      plan: "plus",
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 47,
          windowDurationMins: 10080,
          resetsAt: "2026-07-19T22:26:40.000Z",
        },
      ],
    });
  });

  it("treats a lone duration-less primary as monthly on Free and Go", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        read: { rateLimits: { planType: "free", primary: { usedPercent: 80, resetsAt: null } } },
      }).windows,
    ).toEqual([
      {
        id: "primary",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 80,
        windowDurationMins: 43_200,
      },
    ]);
  });

  it("selects the main Codex allowance and leaves Spark out", () => {
    const spark = {
      limitId: "codex_bengalfox",
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 90, windowDurationMins: 10080 },
    };
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        read: {
          rateLimits: spark,
          rateLimitsByLimitId: {
            codex_bengalfox: spark,
            codex: { secondary: { usedPercent: 42, windowDurationMins: 10080 } },
          },
        },
      }).windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });

  it.each([null, {}])("supports legacy reads with no bucket map: %j", (rateLimitsByLimitId) => {
    const rateLimits = { primary: { usedPercent: 12, windowDurationMins: 300 } };
    expect(
      codexRateLimitsToLimits({ checkedAt, read: { rateLimits, rateLimitsByLimitId } }),
    ).toEqual(codexRateLimitsToLimits({ checkedAt, read: { rateLimits } }));
  });

  it("publishes the account by key, its plan, credits, usage permission and each banked reset", () => {
    const read: CodexSchema.V2GetAccountRateLimitsResponse = {
      accountId: "account-1",
      ordinaryUsageAllowed: false,
      rateLimits: {
        planType: "pro",
        primary: { usedPercent: 100, windowDurationMins: 300 },
        credits: { balance: "12.50", hasCredits: true, unlimited: false },
      },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [
          {
            id: "credit-secret",
            status: "available",
            resetType: "codexRateLimits",
            grantedAt: 1_784_000_000,
            expiresAt: 1_786_000_000,
          },
          { id: "credit-old", status: "redeemed", resetType: "unknown", grantedAt: 1_783_000_000 },
        ],
      },
    };
    const limits = codexRateLimitsToLimits({ checkedAt, read });
    expect(limits).toMatchObject({
      // The first 16 hex digits of sha256("account-1"): the same on every machine.
      accountKey: "07e998012c1137de",
      plan: "pro",
      credits: { balance: "12.50", unlimited: false },
      usageAllowed: false,
      resetCredits: {
        availableCount: 1,
        nextExpiresAt: "2026-08-06T07:06:40.000Z",
        credits: [
          {
            program: "codexRateLimits",
            kind: "full",
            status: "available",
            grantedAt: "2026-07-14T03:33:20.000Z",
            expiresAt: "2026-08-06T07:06:40.000Z",
          },
          {
            program: "unknown",
            kind: "full",
            status: "redeemed",
            grantedAt: "2026-07-02T13:46:40.000Z",
          },
        ],
      },
    });
    expect(JSON.stringify(limits)).not.toMatch(/account-1|credit-secret|credit-old/);
    expect(
      codexRateLimitsToLimits({ checkedAt, read: { rateLimits: {}, ordinaryUsageAllowed: null } }),
    ).not.toHaveProperty("usageAllowed");
  });
});

describe("codexRateLimitsToUpdate", () => {
  it("does not republish cached windows over a newer account probe", () => {
    const cached = {
      primary: { usedPercent: 0, resetsAt: 1_784_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 20, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
    };
    expect(codexRateLimitsToUpdate(cached)?.windows).toHaveLength(2);
    expect(codexRateLimitsToUpdate(structuredClone(cached), cached)).toBeUndefined();

    const changed = { ...cached, secondary: { ...cached.secondary, usedPercent: 21 } };
    expect(codexRateLimitsToUpdate(changed, cached)?.windows.map((window) => window.id)).toEqual([
      "secondary",
    ]);
    expect(codexRateLimitsToUpdate({ primary: cached.primary }, cached)).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({ primary: { ...cached.primary, resetsAt: 1_784_001_000 } }, cached)
        ?.windows,
    ).toHaveLength(1);
    expect(
      codexRateLimitsToUpdate({ primary: { ...cached.primary, usedPercent: 76 } }, cached)
        ?.windows[0]?.usedPercent,
    ).toBe(76);
  });

  it("carries only the windows the notification names", () => {
    expect(
      codexRateLimitsToUpdate({
        secondary: { usedPercent: 51, windowDurationMins: 10080 },
      }),
    ).toEqual({
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 51,
          windowDurationMins: 10080,
        },
      ],
    });
    expect(codexRateLimitsToUpdate({ planType: "plus" })).toBeUndefined();
  });

  it("carries a credit balance only when a turn's reading changes it", () => {
    const credits = { balance: "4.00", hasCredits: true, unlimited: false };
    expect(codexRateLimitsToUpdate({ credits })).toEqual({
      windows: [],
      credits: { balance: "4.00", unlimited: false },
    });
    expect(codexRateLimitsToUpdate({ credits }, { credits: { ...credits } })).toBeUndefined();
    expect(mergeCodexRateLimits({ credits }, { primary: { usedPercent: 3 } })?.credits).toBe(
      credits,
    );
  });

  it("drops credits the account no longer has, in a read and in a turn's update", () => {
    const spent = { balance: "0", hasCredits: false, unlimited: false };
    const rateLimits = { primary: { usedPercent: 12, windowDurationMins: 300 }, credits: spent };
    expect(codexRateLimitsToLimits({ checkedAt, read: { rateLimits } }).credits).toBeUndefined();
    expect(
      codexRateLimitsToUpdate(
        { credits: spent },
        { credits: { balance: "4.00", hasCredits: true, unlimited: false } },
      ),
    ).toEqual({ windows: [], credits: null });
    expect(codexRateLimitsToUpdate({ credits: spent }, { credits: spent })).toBeUndefined();
  });

  it("ignores Spark notifications so they cannot overwrite the main allowance", () => {
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex_bengalfox",
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
        primary: { usedPercent: 0, windowDurationMins: 300 },
        secondary: { usedPercent: 90, windowDurationMins: 10080 },
      }),
    ).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex",
        secondary: { usedPercent: 42, windowDurationMins: 10080 },
      })?.windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("codexRateLimitsFailureMessage", () => {
  it("keeps the JSON-RPC code and nothing else from a request failure", () => {
    const message = (errorMessage: string) =>
      codexRateLimitsFailureMessage(
        new CodexErrors.CodexAppServerRequestError({ code: -32603, errorMessage }),
      );
    expect(
      message(
        "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 500 Internal Server Error",
      ),
    ).toBe("Codex could not read usage (JSON-RPC -32603).");
    expect(
      message(
        'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={"code": "token_revoked"}',
      ),
    ).toBe(
      "Codex's own login on this machine is signed out, so it can't read usage. Sign in to Codex again.",
    );
  });
});

describe("mergeCodexRateLimits", () => {
  it("updates monthly credit usage, retains it when omitted, and clears an explicit null", () => {
    const snapshot = {
      limitId: "codex",
      primary: { usedPercent: 12 },
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
    };
    const individualLimit = { remainingPercent: 75, resetsAt: 1_787_000_000 };
    const changed = mergeCodexRateLimits(snapshot, { individualLimit });
    expect(changed).toEqual({ ...snapshot, individualLimit });
    expect(codexRateLimitsToUpdate(changed!)).toEqual({
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 12,
          windowDurationMins: 300,
        },
        {
          id: "individual",
          scope: "spending-cap",
          kind: "monthly",
          label: "Monthly credit limit",
          usedPercent: 25,
          resetsAt: "2026-08-17T20:53:20.000Z",
        },
      ],
    });

    const retained = mergeCodexRateLimits(changed, { primary: null });
    expect(retained).toEqual({ ...snapshot, primary: null, individualLimit });
    const cleared = mergeCodexRateLimits(retained, { individualLimit: null });
    expect(cleared).toEqual({ ...snapshot, primary: null, individualLimit: null });
    expect(codexRateLimitsToLimits({ checkedAt, read: { rateLimits: cleared! } }).windows).toEqual(
      [],
    );
  });

  it("ignores a model-specific snapshot so it cannot replace the main allowance", () => {
    const main = {
      limitId: "codex",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    };
    expect(
      mergeCodexRateLimits(main, {
        limitId: "spark",
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
        primary: { usedPercent: 3, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      }),
    ).toBe(main);
  });
});

import { codexUsageLimitResetAt } from "./codexUsageLimits.ts";

describe("codexUsageLimitResetAt", () => {
  it("waits for every exhausted window and never invents an unknown reset", () => {
    expect(
      codexUsageLimitResetAt({
        primary: { usedPercent: 100, resetsAt: 2000000000 },
        secondary: { usedPercent: 100, resetsAt: 2000100000 },
      }),
    ).toBe("2033-05-19T07:20:00.000Z");
    expect(codexUsageLimitResetAt({ primary: { usedPercent: 100 } })).toBeNull();
    expect(
      codexUsageLimitResetAt({ primary: { usedPercent: 50, resetsAt: 2000000000 } }),
    ).toBeNull();
  });
});

describe("chatGptSharingLimitReading", () => {
  const now = Date.parse("2026-11-08T00:00:00.000Z");
  const window = (kind: "session" | "weekly", usedPercent: number, resetsAt: string) => ({
    id: kind === "session" ? "primary" : "secondary",
    kind,
    label: kind,
    usedPercent,
    resetsAt,
  });
  const limits = (...windows: ReturnType<typeof window>[]) => ({
    checkedAt: "2026-11-08T00:00:00.000Z",
    windows,
  });

  const reset = (...args: Parameters<typeof chatGptSharingLimitReading>) =>
    chatGptSharingLimitReading(...args).resetAt;

  it("names the app cap and the plan's room only when no window is exhausted", () => {
    const week = "2026-11-11T08:00:00.000Z";
    const session = "2026-11-08T03:00:00.000Z";
    expect(
      chatGptSharingLimitReading(
        limits(window("session", 40, session), window("weekly", 27, week)),
        now,
      ),
    ).toEqual({ resetAt: week, appCap: true, remainingPercent: 73 });
    expect(
      chatGptSharingLimitReading(
        limits(window("session", 100, session), window("weekly", 27, week)),
        now,
      ),
    ).toEqual({ resetAt: session, appCap: false, remainingPercent: 73 });
    expect(chatGptSharingLimitReading(undefined, now)).toEqual({
      resetAt: null,
      appCap: false,
      remainingPercent: null,
    });
  });

  it("resets with the exhausted windows, else with the week for the app's own cap", () => {
    const session = "2026-11-08T03:00:00.000Z";
    const week = "2026-11-11T08:00:00.000Z";
    expect(reset(limits(window("session", 100, session), window("weekly", 60, week)), now)).toBe(
      session,
    );
    expect(reset(limits(window("session", 40, session), window("weekly", 60, week)), now)).toBe(
      week,
    );
    expect(reset(limits(window("session", 100, session), window("weekly", 100, week)), now)).toBe(
      week,
    );
    expect(reset(limits(window("weekly", 100, "2026-11-07T00:00:00.000Z")), now)).toBeNull();
    expect(reset(undefined, now)).toBeNull();
  });
});
