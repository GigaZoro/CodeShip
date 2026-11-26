import { usageWindowLimitEnd } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const later = "2026-09-03T12:00:05.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("preserves the observation time of an omitted window across a sparse update and failed probe", () => {
    const updated = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: later,
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });
    expect(
      resolveUsageLimitsAfterProbe({
        published: updated,
        probed: {
          checkedAt: "2026-09-03T12:00:10.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      })?.windows,
    ).toEqual([
      { ...session, usedPercent: 55, observedAt: later },
      { ...weekly, observedAt: checkedAt },
    ]);
  });

  it("recovers a failed probe from an available stream snapshot and retains it across failed refreshes", () => {
    const failed = {
      checkedAt,
      windows: [session],
      unavailable: { reason: "probeFailed" as const },
    };
    const update = { windows: [session], available: true as const };
    const recovered = applyUsageLimitsUpdate({ previous: failed, checkedAt, update });
    expect(recovered).toEqual({ checkedAt, windows: [{ ...session, observedAt: checkedAt }] });
    expect(resolveUsageLimitsAfterProbe({ published: recovered, probed: failed })).toBe(recovered);
    const unsupported = { ...failed, unavailable: { reason: "unsupported" as const } };
    expect(applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update })).toBe(unsupported);
  });

  it("returns the published object itself when no window moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("keeps exhaustion for the same shared models and restarts it when membership changes", () => {
    const window = {
      ...weekly,
      usedPercent: 100,
      observedAt: checkedAt,
      exhaustedSince: checkedAt,
      scope: { models: ["a", "b"] as const },
    };
    const previous = { checkedAt, windows: [window] };
    const update = (models?: readonly [string, ...string[]]) =>
      applyUsageLimitsUpdate({
        previous,
        checkedAt: later,
        update: {
          windows: [{ ...weekly, usedPercent: 100, ...(models && { scope: { models } }) }],
        },
      });
    expect(update()).toBe(previous);
    expect(update(["b", "a"])).toBe(previous);
    expect(update(["a", "c"])?.windows[0]).toMatchObject({
      scope: { models: ["a", "c"] },
      exhaustedSince: later,
    });
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      accountReadAt: checkedAt,
      windows: [
        { ...session, usedPercent: 55, observedAt: later },
        { ...weekly, observedAt: checkedAt },
      ],
    });
    // A later update still names the full read the account fields came from.
    expect(
      applyUsageLimitsUpdate({
        previous: next,
        checkedAt: "2026-09-03T12:00:09.000Z",
        update: { windows: [{ ...session, usedPercent: 60 }] },
      })?.accountReadAt,
    ).toBe(checkedAt);
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({
      checkedAt,
      windows: [{ ...weekly, observedAt: checkedAt }],
      unavailable: { reason: "probeFailed" },
    });
  });

  it("keeps when a window was first seen used up until it drops below 100%", () => {
    const at = (minutes: number) =>
      DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(checkedAt), { minutes }));
    const spent = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: at(1),
      update: { windows: [{ ...weekly, usedPercent: 100 }] },
    })!;
    const firstSeen = { ...weekly, usedPercent: 100, exhaustedSince: at(1), observedAt: at(1) };
    expect(spent.windows).toEqual([{ ...session, observedAt: checkedAt }, firstSeen]);

    const omitted = applyUsageLimitsUpdate({
      previous: spent,
      checkedAt: at(60),
      update: { windows: [{ ...session, usedPercent: 55 }] },
    })!;
    expect(omitted.windows).toEqual([
      { ...session, usedPercent: 55, observedAt: at(60) },
      firstSeen,
    ]);
    expect(usageWindowLimitEnd(omitted, omitted.windows[1]!)).toBe(Date.parse(at(1 + 300)));

    expect(
      applyUsageLimitsUpdate({
        previous: omitted,
        checkedAt: at(61),
        update: { windows: [{ ...weekly, usedPercent: 100 }] },
      }),
    ).toBe(omitted);

    // A snapshot from before `exhaustedSince` counts from its check, not the update's.
    const unstamped = { checkedAt, windows: [session, { ...weekly, usedPercent: 100 }] };
    expect(
      applyUsageLimitsUpdate({
        previous: unstamped,
        checkedAt: at(60),
        update: { windows: [{ ...session, usedPercent: 55 }] },
      })?.windows[1],
    ).toEqual({ ...weekly, usedPercent: 100, exhaustedSince: checkedAt, observedAt: checkedAt });

    expect(
      applyUsageLimitsUpdate({
        previous: omitted,
        checkedAt: at(62),
        update: { windows: [{ ...weekly, usedPercent: 80 }] },
      })?.windows[1],
    ).toEqual({ ...weekly, usedPercent: 80, observedAt: at(62) });
  });

  it("preserves reset credits and programs when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const resetPrograms = { granted: true, weeklySession: false };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits, resetPrograms },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      accountReadAt: checkedAt,
      windows: [
        { ...session, usedPercent: 55, observedAt: later },
        { ...weekly, observedAt: checkedAt },
      ],
      resetCredits,
      resetPrograms,
    });
    expect(
      applyUsageLimitsUpdate({
        previous: { ...published, resetCreditsError: "unrecognizedScreen", resetPrograms },
        checkedAt: "2026-09-03T12:00:05.000Z",
        update: { windows: [{ ...session, usedPercent: 55 }] },
      }),
    ).toMatchObject({ resetCreditsError: "unrecognizedScreen", resetPrograms });
  });

  it("drops the credits when an update says the account has none", () => {
    const credits = { balance: "4.00", unlimited: false };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, credits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [], credits: null },
    });
    expect(next?.credits).toBeUndefined();
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt,
        update: { windows: [], credits: null },
      }),
    ).toBe(published);
  });

  it("keeps the provider's yes through a window its read saw at 100%, not through one an update uses up", () => {
    const allowed = {
      checkedAt,
      windows: [{ ...session, usedPercent: 100 }, weekly],
      usageAllowed: true,
    };
    const later = "2026-09-03T12:00:05.000Z";
    expect(
      applyUsageLimitsUpdate({
        previous: allowed,
        checkedAt: later,
        update: {
          windows: [
            { ...session, usedPercent: 100 },
            { ...weekly, usedPercent: 30 },
          ],
        },
      })?.usageAllowed,
    ).toBe(true);
    expect(
      applyUsageLimitsUpdate({
        previous: allowed,
        checkedAt: later,
        update: { windows: [{ ...weekly, usedPercent: 100 }] },
      })?.usageAllowed,
    ).toBe(false);
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it.each([
    ["accountKey", "account-a", "account-b"],
    ["credentialFingerprint", "credential-a", "credential-b"],
    ["plan", "pro", "team"],
  ] as const)("keeps observations within their %s", (key, before, after) => {
    const old = {
      ...published,
      checkedAt: later,
      [key]: before,
      windows: [{ ...session, usedPercent: 100, exhaustedSince: "2026-09-03T11:00:00.000Z" }],
    };
    const read = {
      ...published,
      [key]: after,
      windows: [{ ...session, usedPercent: 100 }],
    };
    expect(resolveUsageLimitsAfterProbe({ published: old, probed: read })?.windows).toEqual([
      { ...session, usedPercent: 100, exhaustedSince: checkedAt, observedAt: checkedAt },
    ]);
  });

  it("does not carry exhaustion when a reset starts a new window", () => {
    const old = {
      ...published,
      windows: [{ ...session, usedPercent: 100, exhaustedSince: checkedAt }],
    };
    const newReset = "2026-09-03T20:00:00.000Z";
    const readAt = "2026-09-03T15:00:00.000Z";
    expect(
      resolveUsageLimitsAfterProbe({
        published: old,
        probed: {
          checkedAt: readAt,
          windows: [{ ...session, usedPercent: 100, resetsAt: newReset }],
        },
      })?.windows,
    ).toEqual([
      {
        ...session,
        usedPercent: 100,
        resetsAt: newReset,
        exhaustedSince: readAt,
        observedAt: readAt,
      },
    ]);
  });

  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95, observedAt: later },
        { ...weekly, usedPercent: 70, observedAt: checkedAt },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      accountReadAt: probed.checkedAt,
      windows: [live.windows[0]],
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    for (const probe of [sameTime, newer]) {
      expect(resolveUsageLimitsAfterProbe({ published: live, probed: probe })).toEqual({
        ...probe,
        windows: [{ ...probe.windows[0], observedAt: probe.checkedAt }],
      });
    }
  });

  it("keeps a newer streamed update's credits, and a window it used up withdraws the read's yes", () => {
    const probed = {
      ...published,
      credits: { balance: "4.00", unlimited: false },
      usageAllowed: true,
    };
    const streamed = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 100 }, weekly],
      credits: { balance: "1.00", unlimited: false },
    };
    expect(resolveUsageLimitsAfterProbe({ published: streamed, probed })).toEqual({
      checkedAt: streamed.checkedAt,
      accountReadAt: probed.checkedAt,
      windows: streamed.windows.map((window) => ({ ...window, observedAt: streamed.checkedAt })),
      credits: streamed.credits,
      usageAllowed: false,
    });
    // The read's yes already weighed a window it saw at 100%.
    const usedUp = { ...probed, windows: [{ ...session, usedPercent: 100 }, weekly] };
    expect(
      resolveUsageLimitsAfterProbe({ published: streamed, probed: usedUp })?.usageAllowed,
    ).toBe(true);
  });

  it.each([
    [
      "keeps when the replaced reading first saw it",
      "2026-09-03T11:00:00.000Z",
      100,
      "2026-09-03T11:00:00.000Z",
    ],
    [
      "counts from the replaced check when that reading predates the field",
      undefined,
      100,
      checkedAt,
    ],
    [
      "counts from the probe when the window was not used up before",
      undefined,
      70,
      "2026-09-03T13:00:00.000Z",
    ],
  ] as const)(
    "a probe that still finds a window used up %s",
    (_name, exhaustedSince, publishedPercent, expected) => {
      const probed = {
        checkedAt: "2026-09-03T13:00:00.000Z",
        windows: [session, { ...weekly, usedPercent: 100 }],
      };
      const before = {
        checkedAt,
        windows: [
          session,
          {
            ...weekly,
            usedPercent: publishedPercent,
            ...(exhaustedSince ? { exhaustedSince } : {}),
          },
        ],
      };
      expect(resolveUsageLimitsAfterProbe({ published: before, probed })?.windows[1]).toEqual({
        ...weekly,
        usedPercent: 100,
        exhaustedSince: expected,
        observedAt: probed.checkedAt,
      });
    },
  );

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  it("takes the reset fields a failed probe read, dropping the ones it no longer has", () => {
    const resetPrograms = { granted: true, weeklySession: false };
    const withGrants = {
      ...published,
      resetCredits: { availableCount: 1, credits: [] },
      resetPrograms,
    };
    const failed = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" as const },
      resetPrograms,
    };
    expect(resolveUsageLimitsAfterProbe({ published: withGrants, probed: failed })).toEqual({
      ...published,
      resetPrograms,
    });
  });
});
