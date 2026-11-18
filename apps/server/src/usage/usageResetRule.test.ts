import type {
  ServerProviderResetCredit,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { decideUsageReset, type UsageResetDecision } from "./usageResetRule.ts";

const HOUR = 3_600_000;
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-15T12:00:00.000Z"));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (hours: number) => iso(NOW + hours * HOUR);
const OPTIONS = { nowMs: NOW, maxWaitHours: 48, accountLimitId: "claude" };

const weekly = (
  resetsInHours: number | undefined,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 100,
  ...(resetsInHours === undefined ? {} : { resetsAt: at(resetsInHours) }),
  windowDurationMins: 10_080,
  ...extra,
});
const session = (resetsInHours: number, usedPercent = 100): ServerProviderUsageWindow => ({
  id: "session",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt: at(resetsInHours),
  windowDurationMins: 300,
});
const fable = (
  resetsInHours: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({
  id: "fable",
  kind: "weekly",
  label: "Fable",
  usedPercent: 100,
  resetsAt: at(resetsInHours),
  windowDurationMins: 10_080,
  model: "Fable",
  ...extra,
});
const grant = (
  kind: NonNullable<ServerProviderResetCredit["kind"]>,
  expiresInHours: number | undefined,
  extra: Partial<ServerProviderResetCredit> = {},
): ServerProviderResetCredit => ({
  program: "granted",
  kind,
  usableNow: true,
  ...(expiresInHours === undefined ? {} : { expiresAt: at(expiresInHours) }),
  ...extra,
});
const limits = (
  windows: ServerProviderUsageWindow[],
  credits: ServerProviderResetCredit[],
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({
  checkedAt: iso(NOW),
  windows,
  resetCredits: { availableCount: credits.length, credits },
  ...extra,
});

const claim = (
  kind: string,
  limitId: string,
  boundaryHours: number,
  reason: string,
  model: string | null = null,
): UsageResetDecision =>
  ({
    model,
    action: "claim",
    kind,
    limitId,
    boundaryMs: NOW + boundaryHours * HOUR,
    reason,
  }) as UsageResetDecision;
const wait = (
  reason: string,
  boundaryHours: number | null,
  model: string | null = null,
): UsageResetDecision =>
  ({
    model,
    action: "wait",
    reason,
    boundaryMs: boundaryHours === null ? null : NOW + boundaryHours * HOUR,
  }) as UsageResetDecision;
const run = (reason: string): UsageResetDecision =>
  ({ model: null, action: "run", reason }) as UsageResetDecision;

interface Row {
  readonly name: string;
  readonly limits: ServerProviderUsageLimits;
  /** The account's own decision first, then one per model-scoped meter at 100%. */
  readonly expected: ReadonlyArray<UsageResetDecision>;
  readonly options?: Partial<typeof OPTIONS>;
}

const rows: ReadonlyArray<Row> = [
  {
    name: "waits when the plan reset is 47 hours away with a 48 hour limit",
    limits: limits([weekly(47)], [grant("weekly", 400)]),
    expected: [wait("plan-resets-soon", 47)],
  },
  {
    name: "waits at exactly the limit",
    limits: limits([weekly(48)], [grant("weekly", 400)]),
    expected: [wait("plan-resets-soon", 48)],
  },
  {
    name: "claims when the plan reset is 49 hours away",
    limits: limits([weekly(49)], [grant("weekly", 400)]),
    expected: [claim("weekly", "claude", 49, "reset-too-far")],
  },
  {
    name: "claims a reset expiring before a near plan reset",
    limits: limits([weekly(2)], [grant("weekly", 1)]),
    expected: [claim("weekly", "claude", 2, "reset-expiring")],
  },
  {
    name: "claims a reset expiring at the plan reset",
    limits: limits([weekly(2)], [grant("weekly", 2)]),
    expected: [claim("weekly", "claude", 2, "reset-expiring")],
  },
  {
    name: "waits for a near plan reset when the reset outlives it and the pace is unreadable",
    limits: limits([weekly(2)], [grant("weekly", 300)]),
    expected: [wait("plan-resets-soon", 2)],
  },
  {
    name: "never claims while usage is allowed, whatever a window shows",
    limits: limits([weekly(100)], [grant("full", 1)], { usageAllowed: true }),
    expected: [run("usage-allowed")],
  },
  {
    name: "runs when no window is full",
    limits: limits([weekly(100, { usedPercent: 60 })], [grant("full", 1)]),
    expected: [run("plan-available")],
  },
  {
    name: "treats the fullest windows as blocking when the provider refuses usage",
    limits: limits([weekly(100, { usedPercent: 97 })], [grant("full", 400)], {
      usageAllowed: false,
    }),
    expected: [claim("full", "claude", 100, "reset-too-far")],
  },
  {
    name: "counts the fullest windows as spent when the provider refuses usage before they fill",
    limits: limits([session(4, 95)], [grant("full", 1)], { usageAllowed: false }),
    expected: [claim("full", "claude", 4, "reset-expiring")],
  },
  {
    name: "takes the reset that expires first",
    limits: limits(
      [weekly(100)],
      [grant("full", 300), grant("weekly", 200), grant("full", undefined)],
    ),
    expected: [claim("weekly", "claude", 100, "reset-too-far")],
  },
  {
    name: "sorts a reset without an expiry last",
    limits: limits([weekly(100)], [grant("weekly", undefined), grant("full", 500)]),
    expected: [claim("full", "claude", 100, "reset-too-far")],
  },
  {
    name: "leaves a 5-hour reset out when the plan reset is far",
    limits: limits([weekly(100)], [grant("five_hour", 10), grant("full", 500)]),
    expected: [claim("full", "claude", 100, "reset-too-far")],
  },
  {
    name: "a 5-hour reset alone never clears the weekly limit",
    limits: limits([weekly(100)], [grant("five_hour", 10)]),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "claims a 5-hour reset for the session limit only when it would lapse",
    limits: limits([session(4)], [grant("five_hour", 3)]),
    expected: [claim("five_hour", "claude", 4, "reset-expiring")],
  },
  {
    name: "waits out a session limit when its 5-hour reset outlives the plan reset",
    limits: limits([session(4)], [grant("five_hour", 300)]),
    expected: [wait("plan-resets-soon", 4)],
  },
  {
    name: "needs every blocking meter cleared: a weekly reset does not clear a full session",
    limits: limits([weekly(100), session(4)], [grant("weekly", 400)]),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "a full reset clears every blocking meter, boundary the latest",
    limits: limits([weekly(100), session(4)], [grant("full", 400)]),
    expected: [claim("full", "claude", 100, "reset-too-far")],
  },
  {
    name: "waits when a blocking window has no reset time",
    limits: limits([weekly(undefined)], [grant("full", 1)]),
    expected: [wait("unknown-plan-reset", null)],
  },
  {
    name: "waits when the plan reset has already passed",
    limits: limits([weekly(-1)], [grant("full", 1)]),
    expected: [wait("stale-reading", null)],
  },
  {
    name: "waits when the provider's limits are unreadable",
    limits: limits([weekly(100)], [grant("full", 1)], {
      unavailable: { reason: "probeFailed" },
    }),
    expected: [wait("unmeasured", null)],
  },
  {
    name: "waits on a spent Fable meter too when the provider's limits are unreadable",
    limits: limits([weekly(100), fable(2)], [grant("fable", 1)], {
      unavailable: { reason: "probeFailed" },
    }),
    expected: [wait("unmeasured", null), wait("unmeasured", null, "Fable")],
  },
  {
    name: "never claims a paused grant",
    limits: limits([weekly(100)], [grant("full", 1, { paused: true })]),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "never claims a grant that is not usable now",
    limits: limits([weekly(100)], [grant("full", 1, { usableNow: false })]),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "claims a held grant read before the account reached the limit its kind clears",
    limits: limits(
      [weekly(100)],
      [grant("weekly", undefined, { usableNow: false, requiresLimit: true })],
    ),
    expected: [claim("weekly", "claude", 100, "reset-too-far")],
  },
  {
    name: "claims a grant Claude offers now before a held one that expires no sooner",
    limits: limits(
      [weekly(100)],
      [
        grant("weekly", undefined, { usableNow: false, requiresLimit: true }),
        grant("full", undefined),
      ],
    ),
    expected: [claim("full", "claude", 100, "reset-too-far")],
  },
  {
    name: "keeps a held grant whose kind does not clear the limit reached",
    limits: limits(
      [weekly(100)],
      [grant("five_hour", undefined, { usableNow: false, requiresLimit: true })],
    ),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "never claims a held grant whose kind Claude did not name",
    limits: limits(
      [weekly(100)],
      [
        {
          program: "granted",
          kindUnknownReason: "totalOnly",
          resetsLeft: 2,
          expiresAt: at(400),
          usableNow: false,
          requiresLimit: true,
        },
      ],
    ),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "never claims an expired reset",
    limits: limits([weekly(100)], [grant("full", -1)]),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "claims a grant that requires a limit, since the account is at one",
    limits: limits([weekly(100)], [grant("full", 400, { requiresLimit: true })]),
    expected: [claim("full", "claude", 100, "reset-too-far")],
  },
  {
    name: "never claims a grant that requires a limit while no limit is out",
    limits: limits([weekly(100, { usedPercent: 40 })], [grant("full", 1, { requiresLimit: true })]),
    expected: [run("plan-available")],
  },
  {
    name: "reads a Codex credit by its status",
    limits: limits(
      [weekly(100)],
      [{ program: "codexRateLimits", kind: "full", status: "available", expiresAt: at(500) }],
    ),
    expected: [claim("full", "claude", 100, "reset-too-far")],
  },
  {
    name: "ignores a Codex credit that is not available",
    limits: limits(
      [weekly(100)],
      [{ program: "codexRateLimits", kind: "full", status: "redeemed", expiresAt: at(500) }],
    ),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "does not count Codex's monthly credit window as a limit",
    limits: limits(
      [
        {
          id: "individual",
          kind: "monthly",
          label: "Monthly credit limit",
          usedPercent: 100,
          resetsAt: at(100),
        },
      ],
      [grant("full", 500)],
    ),
    expected: [run("plan-available")],
  },
  {
    name: "does not count Claude's monthly spend as a limit",
    limits: limits(
      [
        session(2, 40),
        { id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: 100 },
      ],
      [grant("full", 500)],
    ),
    expected: [run("plan-available")],
  },
  {
    name: "counts a monthly rate limit that states its length",
    limits: limits(
      [weekly(200, { id: "primary", kind: "monthly", windowDurationMins: 43_200 })],
      [grant("full", 500)],
    ),
    expected: [claim("full", "codex", 200, "reset-too-far")],
    options: { accountLimitId: "codex" },
  },
  {
    name: "a Fable reset clears only Fable's own meter",
    limits: limits(
      [weekly(100, { usedPercent: 50 }), fable(100)],
      [grant("fable", 400), grant("weekly", 300)],
    ),
    expected: [
      run("plan-available"),
      claim("fable", "weekly_scoped:fable", 100, "reset-too-far", "Fable"),
    ],
  },
  {
    name: "a weekly reset does not clear Fable's meter",
    limits: limits([weekly(100, { usedPercent: 50 }), fable(100)], [grant("weekly", 300)]),
    expected: [run("plan-available"), wait("no-reset", 100, "Fable")],
  },
  {
    name: "a full reset clears Fable's meter",
    limits: limits([weekly(100, { usedPercent: 50 }), fable(100)], [grant("full", 300)]),
    expected: [
      run("plan-available"),
      claim("full", "weekly_scoped:fable", 100, "reset-too-far", "Fable"),
    ],
  },
  {
    name: "waits on Fable's meter by the same wait rule",
    limits: limits([weekly(100, { usedPercent: 50 }), fable(47)], [grant("fable", 400)]),
    expected: [run("plan-available"), wait("plan-resets-soon", 47, "Fable")],
  },
  {
    name: "a Fable reset never clears an unscoped meter",
    limits: limits([weekly(100)], [grant("fable", 400)]),
    expected: [wait("no-reset", 100)],
  },
  {
    name: "keeps a Fable reset while the account's own week holds Fable too",
    limits: limits([weekly(100), fable(100)], [grant("fable", 1)]),
    expected: [wait("no-reset", 100), wait("no-reset", 100, "Fable")],
  },
  {
    name: "the account's own limit comes before a scoped one",
    limits: limits([weekly(100), fable(100)], [grant("fable", 100), grant("full", 400)]),
    expected: [
      claim("full", "claude", 100, "reset-too-far"),
      claim("full", "weekly_scoped:fable", 100, "reset-too-far", "Fable"),
    ],
  },
  {
    name: "claims a reset that expires before the meter next runs out at its pace",
    // 100% after 3 days of a 7-day window runs out again 3 days into the next one.
    limits: limits([weekly(24 * 4, { usedPercent: 100 })], [grant("weekly", 24 * 4 + 24 * 3 - 1)]),
    expected: [claim("weekly", "claude", 24 * 4, "reset-expiring")],
    options: { maxWaitHours: 200 },
  },
  {
    name: "an earlier-expiring 5-hour reset beats a far full one",
    limits: limits([session(4)], [grant("five_hour", 1), grant("full", 400)]),
    expected: [claim("five_hour", "claude", 4, "reset-expiring")],
    options: { maxWaitHours: 0 },
  },
  {
    name: "only meters the reset clears count toward its next run-out",
    // The session runs out again within hours, but a weekly reset cannot clear it.
    limits: limits([weekly(24), session(1, 90)], [grant("weekly", 30)]),
    expected: [claim("weekly", "claude", 24, "reset-expiring")],
  },
  {
    name: "a window that outlasts the plan reset runs out on what it has left",
    // The week's last 2% lasts about 1.4 hours at its pace, so it runs out before the reset expires.
    limits: limits([session(1), weekly(100, { usedPercent: 98 })], [grant("full", 4)]),
    expected: [wait("plan-resets-soon", 1)],
  },
  {
    name: "claims a reset that expires before the week's last share runs out",
    limits: limits([session(1), weekly(100, { usedPercent: 98 })], [grant("full", 2)]),
    expected: [claim("full", "claude", 1, "reset-expiring")],
  },
  {
    name: "keeps a full reset for a Fable week that runs out before it expires",
    // Fable's last 2% lasts about 1.4 hours once the session is back, and the reset can clear it.
    limits: limits(
      [session(1), weekly(100, { usedPercent: 50 }), fable(100, { usedPercent: 98 })],
      [grant("full", 4)],
    ),
    expected: [wait("plan-resets-soon", 1)],
  },
  {
    name: "keeps a full reset for the account's own week, which runs on while Fable waits",
    // The week's last 10% runs out in about 7.6 hours, before the reset expires.
    limits: limits([weekly(100, { usedPercent: 90 }), fable(30)], [grant("full", 20)]),
    expected: [run("plan-available"), wait("plan-resets-soon", 30, "Fable")],
  },
  {
    name: "claims a full reset that expires while the account waits, even with Fable's reset unknown",
    limits: limits(
      [
        session(1),
        weekly(100, { usedPercent: 50 }),
        weekly(undefined, { id: "fable", label: "Fable", model: "Fable" }),
      ],
      [grant("full", 0.5)],
    ),
    expected: [
      claim("full", "claude", 1, "reset-expiring"),
      wait("unknown-plan-reset", null, "Fable"),
    ],
  },
  {
    name: "claims a 5-hour reset when the week runs out first and holds the session past its expiry",
    // The week's last 2% lasts about 1.4 hours once the session is back; then nothing runs until it resets.
    limits: limits([session(1), weekly(100, { usedPercent: 98 })], [grant("five_hour", 6)]),
    expected: [claim("five_hour", "claude", 1, "reset-expiring")],
  },
  {
    name: "keeps a 5-hour reset for the session's next run-out before it expires",
    limits: limits([session(1), weekly(100, { usedPercent: 50 })], [grant("five_hour", 6)]),
    expected: [wait("plan-resets-soon", 1)],
  },
  {
    name: "claims a full reset for Fable when the account's own week lasts past its expiry",
    limits: limits([weekly(100, { usedPercent: 50 }), fable(30)], [grant("full", 20)]),
    expected: [
      run("plan-available"),
      claim("full", "weekly_scoped:fable", 30, "reset-expiring", "Fable"),
    ],
  },
  {
    name: "keeps a reset that outlives the next run-out",
    limits: limits([weekly(24 * 4, { usedPercent: 100 })], [grant("weekly", 24 * 4 + 24 * 3 + 1)]),
    expected: [wait("plan-resets-soon", 24 * 4)],
    options: { maxWaitHours: 200 },
  },
];

describe("decideUsageReset", () => {
  it.each(rows)("$name", ({ limits: reading, expected, options }) => {
    assert.deepEqual(decideUsageReset(reading, { ...OPTIONS, ...options }), expected);
  });

  it("applies the limit given, not 48 hours", () => {
    const reading = limits([weekly(30)], [grant("full", 400)]);
    assert.equal(decideUsageReset(reading, { ...OPTIONS, maxWaitHours: 24 })[0]?.action, "claim");
    assert.equal(decideUsageReset(reading, { ...OPTIONS, maxWaitHours: 30 })[0]?.action, "wait");
  });
});
