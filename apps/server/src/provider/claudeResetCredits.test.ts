import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ServerProviderUsageLimits } from "@t3tools/contracts/providerUsageLimits";
import { usageAccountKey } from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import {
  GRANTS_REACTIONS,
  answeringClaim,
  makeFakeClaude,
  withFakeClaude,
  type FakeClaude,
  type FakeClaudeScript,
} from "./claudeLimitResetTerminal.testkit.ts";
import { GRANTED_TEXTS, WEEKLY_SESSION_TEXTS } from "./claudeLimitResetText.ts";
import * as ClaudeResetCredits from "./claudeResetCredits.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

interface Login {
  readonly directory: string;
  readonly accountConfigPath: string;
}

const configJson = (features?: Record<string, unknown>, accountUuid?: string) =>
  JSON.stringify({
    ...(accountUuid === undefined ? {} : { oauthAccount: { accountUuid } }),
    ...(features === undefined ? {} : { cachedGrowthBookFeatures: features }),
  });

const writeConfig = Effect.fnUntraced(function* (
  features?: Record<string, unknown>,
  accountUuid?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const accountConfigPath = path.join(directory, ".claude.json");
  yield* fs.writeFileString(accountConfigPath, configJson(features, accountUuid));
  return { directory, accountConfigPath } satisfies Login;
});

const usage = (
  usedPercent: number,
  {
    checkedAt = "2026-11-15T12:00:00.000Z",
    accountKey,
  }: { checkedAt?: string; accountKey?: string | undefined } = {},
): ServerProviderUsageLimits => ({
  checkedAt,
  ...(accountKey === undefined ? {} : { accountKey }),
  windows: [{ id: "five_hour", kind: "session", label: "5-hour", usedPercent }],
});

/** One instance's resets on `login`; instances made on the same login share its lock. */
const makeResetsOn = Effect.fnUntraced(function* (login: Login, fake: FakeClaude) {
  const reads = yield* Queue.unbounded<void>();
  const resets = yield* withFakeClaude(
    fake,
    ClaudeResetCredits.makeClaudeLimitResets({
      accountConfigPath: login.accountConfigPath,
      loginKey: login.directory,
      terminal: { binaryPath: "claude", environment: {}, cwd: `${login.directory}/limit-reset` },
      onRead: Queue.offer(reads, undefined).pipe(Effect.asVoid),
    }),
  ).pipe(Effect.provideService(HostProcess.Platform, "linux"));
  return { resets, finishedRead: Queue.take(reads) };
});

const makeResets = Effect.fnUntraced(function* (
  features: Record<string, unknown> | undefined,
  script: FakeClaudeScript,
  accountUuid?: string,
) {
  yield* TestClock.setTime(NOW);
  const login = yield* writeConfig(features, accountUuid);
  const fake = makeFakeClaude(script);
  return { ...(yield* makeResetsOn(login, fake)), fake, login };
});

const GRANTED_ON = { tengu_cedar_ember: { enabled: true } };
const WEEKLY_SESSION_ON = { tengu_nifty_lemur: { enabled: true } };

it.layer(NodeServices.layer)("readClaudeLimitResetPrograms", (it) => {
  it.effect.each([
    {
      name: "takes each flag's own texts",
      features: {
        tengu_cedar_ember: { enabled: true, spentLine: "Spent · {resets} left", noKindLine: "" },
        tengu_nifty_lemur: { enabled: false },
      },
      programs: { granted: { ...GRANTED_TEXTS, spentLine: "Spent · {resets} left" } },
    },
    {
      name: "counts only flags whose value is an enabled object",
      features: { tengu_cedar_ember: true, tengu_nifty_lemur: { enabled: true } },
      programs: { weeklySession: WEEKLY_SESSION_TEXTS },
    },
    { name: "is empty without cached flags", features: undefined, programs: {} },
  ])("$name", ({ features, programs }) =>
    Effect.gen(function* () {
      const { accountConfigPath } = yield* writeConfig(features);
      expect(yield* ClaudeResetCredits.readClaudeLimitResetPrograms(accountConfigPath)).toEqual(
        programs,
      );
    }),
  );

  it.effect("is empty when the config is missing, and fails when it is garbled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, accountConfigPath } = yield* writeConfig();
      expect(
        yield* ClaudeResetCredits.readClaudeLimitResetPrograms(`${directory}/missing.json`),
      ).toEqual({});
      yield* fs.writeFileString(accountConfigPath, "{not json");
      const garbled = yield* Effect.flip(
        ClaudeResetCredits.readClaudeLimitResetPrograms(accountConfigPath),
      );
      expect(garbled.reason).toBe("readFailed");
    }),
  );
});

describe("isLimitResetReadDue", () => {
  const ACCOUNT = "account-a";
  const reading = { at: NOW, accountKey: ACCOUNT, redemptions: 0, grants: [] };
  const failure = (attempts: number) => ({
    at: NOW,
    reason: "unrecognizedScreen" as const,
    attempts,
    redemptions: 0,
  });
  it.each([
    { name: "the first read", state: { limited: false }, after: 0, due: true },
    { name: "a fresh read", state: { limited: false, reading }, after: HOUR, due: false },
    { name: "six hours on", state: { limited: false, reading }, after: 6 * HOUR, due: true },
    {
      name: "a new limit",
      state: { limited: false, reading },
      after: MINUTE,
      limited: true,
      due: true,
    },
    {
      name: "the same limit",
      state: { limited: true, reading },
      after: MINUTE,
      limited: true,
      due: false,
    },
    {
      name: "a reset used on the login since the read",
      state: { limited: false, reading },
      after: MINUTE,
      redemptions: 1,
      due: true,
    },
    {
      name: "another account's usage before a failed read's retry",
      state: { limited: false, reading },
      after: 9 * MINUTE,
      accountKey: "account-b",
      due: false,
    },
    {
      name: "another account's usage at a failed read's retry",
      state: { limited: false, reading },
      after: 10 * MINUTE,
      accountKey: "account-b",
      due: true,
    },
    {
      name: "a first failure before its retry",
      state: { limited: false, failure: failure(1) },
      after: 9 * MINUTE,
      limited: true,
      due: false,
    },
    {
      name: "a first failure at its retry",
      state: { limited: false, failure: failure(1) },
      after: 10 * MINUTE,
      due: true,
    },
    {
      name: "a failure followed by a reset used on the login",
      state: { limited: false, failure: failure(1) },
      after: MINUTE,
      redemptions: 1,
      due: true,
    },
    {
      name: "a third failure before its doubled retry",
      state: { limited: false, failure: failure(3) },
      after: 39 * MINUTE,
      due: false,
    },
    {
      name: "a long failing run, capped at six hours",
      state: { limited: false, failure: failure(12) },
      after: 6 * HOUR,
      due: true,
    },
  ])(
    "$name: $due",
    ({ state, after, limited = false, redemptions = 0, accountKey = ACCOUNT, due }) => {
      expect(
        ClaudeResetCredits.isLimitResetReadDue(state, {
          now: NOW + after,
          limited,
          redemptions,
          accountKey,
        }),
      ).toBe(due);
    },
  );
});

describe("withUsage", () => {
  const seen = { limited: true, usageCheckedAt: NOW };
  it.each([
    {
      name: "newer usage replaces the limit state",
      checkedAt: "2026-11-15T12:05:00.000Z",
      next: { limited: false, usageCheckedAt: NOW + 5 * MINUTE },
    },
    {
      name: "usage read earlier but seen later changes nothing",
      checkedAt: "2026-11-15T11:00:00.000Z",
      next: seen,
    },
    {
      name: "usage that could not be read changes nothing",
      checkedAt: "2026-11-15T12:05:00.000Z",
      unavailable: true,
      next: seen,
    },
  ])("$name", ({ checkedAt, unavailable = false, next }) => {
    const seenUsage = usage(0, { checkedAt });
    expect(
      ClaudeResetCredits.withUsage(
        seen,
        unavailable ? { ...seenUsage, unavailable: { reason: "probeFailed" } } : seenUsage,
      ),
    ).toEqual(next);
  });
});

it.layer(Layer.mergeAll(NodeServices.layer, ResetCreditCoordinator.layerTest))(
  "makeClaudeLimitResets",
  (it) => {
    it.effect("with both flags off publishes no grants and starts no terminal", () =>
      Effect.gen(function* () {
        const { resets, fake } = yield* makeResets(undefined, { reactions: GRANTS_REACTIONS });
        expect(yield* resets.current(usage(100))).toEqual({
          resetPrograms: { granted: false, weeklySession: false },
        });
        expect(yield* resets.claim(undefined)).toBe("noCredit");
        expect(fake.spawns).toEqual([]);
      }),
    );

    it.effect("reports an unreadable config without its text and starts no terminal", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { resets, fake, login } = yield* makeResets(GRANTED_ON, {
          reactions: GRANTS_REACTIONS,
        });
        // JSON.parse quotes this text in its error.
        yield* fs.writeFileString(login.accountConfigPath, "person@example.com");
        expect(yield* resets.current(usage(100))).toEqual({ resetCreditsError: "readFailed" });
        const error = yield* Effect.flip(resets.claim(undefined));
        expect(error.reason).toBe("readFailed");
        expect(error.cause).toBeUndefined();
        expect(fake.spawns).toEqual([]);
      }),
    );

    it.effect("reads the grants beside usage, again at a new limit, and after six hours", () =>
      Effect.gen(function* () {
        const { resets, fake, finishedRead } = yield* makeResets(GRANTED_ON, {
          reactions: GRANTS_REACTIONS,
        });
        const resetPrograms = { granted: true, weeklySession: false };
        expect(yield* resets.current(usage(40))).toEqual({ resetPrograms });
        yield* finishedRead;
        expect(yield* resets.current(usage(40))).toEqual({
          resetCredits: {
            availableCount: 3,
            nextExpiresAt: "2026-11-20T00:00:00.000Z",
            credits: [
              {
                program: "cedar_ember",
                kind: "weekly",
                resetsLeft: 2,
                expiresAt: "2026-12-01T00:00:00.000Z",
                usableNow: true,
                requiresLimit: true,
              },
              {
                program: "cedar_ember",
                kind: "full",
                resetsLeft: 1,
                expiresAt: "2026-11-20T00:00:00.000Z",
                usableNow: true,
                requiresLimit: false,
              },
              { program: "cedar_ember", kind: "fable", usableNow: false, requiresLimit: true },
            ],
          },
          resetPrograms,
        });
        expect(fake.spawns).toHaveLength(1);

        yield* resets.current(usage(100));
        yield* finishedRead;
        expect(fake.spawns).toHaveLength(2);

        yield* TestClock.adjust(6 * HOUR);
        yield* resets.current(usage(100));
        yield* finishedRead;
        expect(fake.spawns).toHaveLength(3);
        expect(fake.used).toEqual([]);
      }),
    );

    it.effect("publishes why a read failed, never its text", () =>
      Effect.gen(function* () {
        const { resets, finishedRead } = yield* makeResets(GRANTED_ON, {
          reactions: { "/limit-reset": { answer: "Resets work differently now" } },
        });
        yield* resets.current(usage(40));
        yield* finishedRead;
        expect(yield* resets.current(usage(40))).toEqual({
          resetCreditsError: "unrecognizedScreen",
          resetPrograms: { granted: true, weeklySession: false },
        });
      }),
    );

    it.effect(
      "uses the grant that expires first, reading the grants first when none are known",
      () =>
        Effect.gen(function* () {
          const { resets, fake, finishedRead } = yield* makeResets(GRANTED_ON, {
            reactions: GRANTS_REACTIONS,
          });
          expect(yield* resets.claim(undefined)).toBe("reset");
          expect(fake.used).toEqual(["/limit-reset full"]);
          expect(fake.spawns).toHaveLength(2);

          // A claim may change the grants, so the next usage read reads them again.
          expect(yield* resets.current(usage(0))).toEqual({
            resetPrograms: { granted: true, weeklySession: false },
          });
          yield* finishedRead;
          expect(yield* resets.claim(undefined)).toBe("reset");
          expect(fake.used).toEqual(["/limit-reset full", "/limit-reset full"]);
          expect(fake.spawns).toHaveLength(4);
        }),
    );

    it.effect(
      "uses the weekly 5-hour reset only unasked, and publishes when it is available again",
      () =>
        Effect.gen(function* () {
          const { resets, fake } = yield* makeResets(WEEKLY_SESSION_ON, {
            reactions: {
              hi: { answer: "You've hit your 5-hour limit · resets 5pm" },
              "/limit-reset": {
                answer:
                  "5-hour limit reset · next reset available Nov 22 · your weekly limit still applies",
                uses: true,
              },
            },
          });
          expect(yield* resets.claim(undefined, "weekly")).toBe("noCredit");
          expect(yield* resets.claim(undefined, "five_hour")).toBe("noCredit");
          expect(fake.spawns).toEqual([]);
          expect(yield* resets.claim(undefined)).toBe("reset");
          expect(yield* resets.current(usage(0))).toEqual({
            resetPrograms: {
              granted: false,
              weeklySession: true,
              weeklySessionAvailableAt: "2026-11-22T00:00:00.000Z",
            },
          });
          expect(fake.used).toEqual(["/limit-reset"]);
        }),
    );

    it.effect("fails a claim Claude gave no outcome for, and reads the grants again after it", () =>
      Effect.gen(function* () {
        const { resets, fake, finishedRead } = yield* makeResets(GRANTED_ON, {
          reactions: answeringClaim(GRANTS_REACTIONS, "/limit-reset full", "Something new"),
        });
        yield* resets.current(usage(100));
        yield* finishedRead;
        expect((yield* Effect.flip(resets.claim(undefined))).reason).toBe("unrecognizedScreen");
        expect(fake.used).toEqual(["/limit-reset full"]);
        // The reset may have been used, so the grants read before it are not shown.
        expect(yield* resets.current(usage(100))).toEqual({
          resetPrograms: { granted: true, weeklySession: false },
        });
        yield* finishedRead;
        expect(fake.spawns).toHaveLength(3);
      }),
    );

    it.effect("takes turns with another instance on the same login and drops grants it used", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const hold = {
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const fake = makeFakeClaude({ reactions: GRANTS_REACTIONS, holdSpawn: hold });
        const login = yield* writeConfig(GRANTED_ON);
        const first = yield* makeResetsOn(login, fake);
        const second = yield* makeResetsOn(login, fake);
        const resetPrograms = { granted: true, weeklySession: false };

        yield* first.resets.current(usage(100));
        yield* Deferred.await(hold.reached);
        const claim = yield* Effect.forkChild(second.resets.claim(undefined));
        yield* Deferred.succeed(hold.release, undefined);
        yield* first.finishedRead;
        expect(yield* Fiber.join(claim)).toBe("reset");
        expect(fake.peak()).toBe(1);

        expect(yield* first.resets.current(usage(100))).toEqual({ resetPrograms });
        yield* first.finishedRead;
        expect(fake.spawns).toHaveLength(4);
        expect(yield* first.resets.current(usage(100))).toMatchObject({
          resetCredits: { availableCount: 3 },
        });
      }),
    );

    it.effect("waits for another instance on the login, reading once however often it is due", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const hold = {
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const login = yield* writeConfig(GRANTED_ON);
        const first = yield* makeResetsOn(
          login,
          makeFakeClaude({ reactions: GRANTS_REACTIONS, holdSpawn: hold }),
        );
        const fake = makeFakeClaude({ reactions: GRANTS_REACTIONS });
        const second = yield* makeResetsOn(login, fake);

        yield* first.resets.current(usage(40));
        yield* Deferred.await(hold.reached);
        yield* second.resets.current(usage(100));
        yield* second.resets.current(usage(100));
        yield* Deferred.succeed(hold.release, undefined);
        yield* first.finishedRead;
        yield* second.finishedRead;
        // The claim queues behind any second read, so its spawn comes last.
        expect(yield* second.resets.claim(undefined)).toBe("reset");
        expect(fake.spawns).toHaveLength(2);
      }),
    );

    it.effect("shows and uses grants only for the account they were read for", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { resets, fake, finishedRead, login } = yield* makeResets(
          GRANTED_ON,
          { reactions: GRANTS_REACTIONS },
          "account-a",
        );
        const accountA = usage(40, { accountKey: usageAccountKey("account-a") });
        const accountB = usage(40, { accountKey: usageAccountKey("account-b") });
        yield* resets.current(accountA);
        yield* finishedRead;
        expect(yield* resets.current(accountA)).toHaveProperty("resetCredits");

        // The login switches while Claude starts for a claim.
        const hold = {
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const held = makeFakeClaude({ reactions: GRANTS_REACTIONS, holdSpawn: hold });
        const other = yield* makeResetsOn(login, held);
        const claiming = yield* other.resets
          .claim(accountA.accountKey, "full")
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(hold.reached);
        yield* fs.writeFileString(login.accountConfigPath, configJson(GRANTED_ON, "account-b"));
        yield* Deferred.succeed(hold.release, undefined);
        expect((yield* Fiber.join(claiming)).reason).toBe("accountChanged");
        expect(held.submitted).toEqual([]);

        expect(yield* resets.current(accountB)).not.toHaveProperty("resetCredits");
        expect(fake.spawns).toHaveLength(1);
        const claim = yield* Effect.flip(resets.claim(accountA.accountKey));
        expect(claim.reason).toBe("accountChanged");
        expect(fake.spawns).toHaveLength(1);
        yield* TestClock.adjust(10 * MINUTE);
        yield* resets.current(accountB);
        yield* finishedRead;
        expect(yield* resets.current(accountB)).toHaveProperty("resetCredits");
      }),
    );
  },
);
