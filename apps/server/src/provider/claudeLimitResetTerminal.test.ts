import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import {
  CLAUDE_LIMIT_RESET_TIMINGS,
  ClaudeLimitResetError,
  claimClaudeGrantedReset,
  claimClaudeWeeklySessionReset,
  readClaudeLimitResets,
  type ClaudeLimitResetPrograms,
} from "./claudeLimitResetTerminal.ts";
import {
  GRANTS_REACTIONS,
  makeFakeClaude,
  withFakeClaude,
  type FakeClaude,
  type FakeClaudeScript,
} from "./claudeLimitResetTerminal.testkit.ts";
import {
  GRANTED_TEXTS,
  WEEKLY_SESSION_DESCRIPTION,
  WEEKLY_SESSION_TEXTS,
} from "./claudeLimitResetText.ts";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const GRANTED: ClaudeLimitResetPrograms = { granted: GRANTED_TEXTS };
const WEEKLY_SESSION: ClaudeLimitResetPrograms = { weeklySession: WEEKLY_SESSION_TEXTS };
const ENTER = "\r";

const options = (programs: Effect.Effect<ClaudeLimitResetPrograms>) => ({
  binaryPath: "claude",
  environment: {
    CLAUDE_CONFIG_DIR: "/accounts/b",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_CODE_CHILD_SESSION: "1",
    ANTHROPIC_API_KEY: "parent-key",
    ANTHROPIC_AUTH_TOKEN: "gateway-token",
    ANTHROPIC_BASE_URL: "https://gateway.example",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "instance-token",
    TZ: "America/Los_Angeles",
  },
  cwd: "/state/limit-reset",
  programs,
});

/** Runs `effect` against `fake`; each test sets the clock first, so a forked run sees it. */
const withFake = <A, E>(fake: FakeClaude, effect: Effect.Effect<A, E>) =>
  withFakeClaude(fake, effect).pipe(Effect.provideService(HostProcess.Platform, "linux"));

const read = Effect.fnUntraced(function* (script: FakeClaudeScript) {
  yield* TestClock.setTime(NOW);
  const fake = makeFakeClaude(script);
  const grants = yield* withFake(
    fake,
    readClaudeLimitResets(options(Effect.succeed(GRANTED)), GRANTED_TEXTS),
  );
  return { grants, fake };
});

describe("readClaudeLimitResets", () => {
  it.effect("reads every grant past first-run screens and half-drawn answers, using none", () =>
    Effect.gen(function* () {
      const { grants, fake } = yield* read({
        firstRun: ["theme", "notes", "trust", "chrome", "fullscreen"],
        reactions: GRANTS_REACTIONS,
        splitAnswers: true,
      });
      expect(grants).toEqual([
        {
          kind: "weekly",
          resetsLeft: 2,
          expiresAt: "2026-12-01T00:00:00.000Z",
          usableNow: true,
          requiresLimit: true,
        },
        {
          kind: "full",
          resetsLeft: 1,
          expiresAt: "2026-11-20T00:00:00.000Z",
          usableNow: true,
          requiresLimit: false,
        },
        { kind: "fable", usableNow: false, requiresLimit: true },
      ]);
      expect(fake.used).toEqual([]);
      expect(fake.submitted).toEqual([
        "/limit-reset",
        "/limit-reset 5-hour",
        "/limit-reset weekly",
        "/limit-reset full",
        "/limit-reset fable",
      ]);
      // The trust prompt starts on "No, exit"; Down moves to "Yes" before Enter.
      expect(fake.keys.slice(0, 4)).toEqual([ENTER, ENTER, "\x1b[B", ENTER]);
      expect(fake.spawns).toHaveLength(1);
      expect(fake.spawns[0]).toMatchObject({ shell: "claude", cwd: "/state/limit-reset" });
      expect(fake.spawns[0]!.env).toEqual({
        CLAUDE_CONFIG_DIR: "/accounts/b",
        CLAUDE_CODE_OAUTH_TOKEN: "instance-token",
        TZ: "UTC",
      });
      expect(fake.alive()).toBe(0);
    }),
  );

  it.effect.each([
    { name: "none", answer: "No reset to use · you're not at a usage limit right now", grants: [] },
    { name: "spent", answer: "Reset used · no resets left", grants: [] },
    {
      name: "paused",
      answer: "Your reset can't be used right now · it is paused · 1 reset left · use by Dec 1",
      grants: [
        {
          kindUnknownReason: "totalOnly",
          resetsLeft: 1,
          expiresAt: "2026-12-01T00:00:00.000Z",
          usableNow: false,
          paused: true,
        },
      ],
    },
    {
      name: "saved for a limit",
      answer:
        "You have a reset saved for when you reach a usage limit · run /limit-reset when you do · 2 resets left · use by Dec 1",
      grants: [
        {
          kindUnknownReason: "totalOnly",
          resetsLeft: 2,
          expiresAt: "2026-12-01T00:00:00.000Z",
          usableNow: false,
          requiresLimit: true,
        },
      ],
    },
  ])("reads Claude's $name answer", ({ answer, grants: expected }) =>
    Effect.gen(function* () {
      const { grants, fake } = yield* read({ reactions: { "/limit-reset": { answer } } });
      expect(grants).toEqual(expected);
      expect(fake.submitted).toEqual(["/limit-reset"]);
    }),
  );

  it.effect.each([
    {
      name: "an answer it does not know",
      script: { reactions: { "/limit-reset": { answer: "Resets work differently now" } } },
      reason: "unrecognizedScreen",
      submitted: ["/limit-reset"],
    },
    {
      name: "the lower-priority answer, given before any grant is read",
      script: {
        reactions: {
          "/limit-reset": {
            answer:
              "Resets can't be used while you continue at lower priority · run /limit-reset after that ends",
          },
        },
      },
      reason: "lowPriority",
      submitted: ["/limit-reset"],
    },
    {
      name: "a screen it does not know",
      script: { unknownScreen: [" Welcome back! Here is what's new"], reactions: {} },
      reason: "unrecognizedScreen",
      submitted: [],
      clock: true,
    },
    {
      name: "the weekly 5-hour reset's description",
      script: {
        suggestions: [`  /limit-reset   ${WEEKLY_SESSION_DESCRIPTION}`],
        reactions: GRANTS_REACTIONS,
      },
      reason: "programChanged",
      submitted: [],
    },
    {
      name: "another command selected in the typeahead",
      script: {
        suggestions: ["  ❯ /login   Switch Anthropic accounts"],
        reactions: GRANTS_REACTIONS,
      },
      reason: "unrecognizedScreen",
      submitted: [],
    },
    {
      name: "the login screen",
      script: { signedOut: true, reactions: GRANTS_REACTIONS },
      reason: "signedOut",
      submitted: [],
    },
    {
      name: "a start that never finishes",
      script: {
        holdSpawn: { reached: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() },
        reactions: GRANTS_REACTIONS,
      },
      reason: "readFailed",
      submitted: [],
      clock: true,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    script: FakeClaudeScript;
    reason: string;
    submitted: ReadonlyArray<string>;
    clock?: boolean;
  }>)("stops at $name without using a reset", ({ script, reason, submitted, clock }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fake = makeFakeClaude(script);
      const run = withFake(
        fake,
        readClaudeLimitResets(options(Effect.succeed(GRANTED)), GRANTED_TEXTS).pipe(Effect.flip),
      );
      const error = clock
        ? yield* run.pipe(
            Effect.forkChild,
            Effect.tap(() => TestClock.adjust(CLAUDE_LIMIT_RESET_TIMINGS.startup)),
            Effect.flatMap(Fiber.join),
          )
        : yield* run;
      expect(error.reason).toBe(reason);
      expect(fake.submitted).toEqual(submitted);
      expect(fake.used).toEqual([]);
      expect(fake.alive()).toBe(0);
    }),
  );

  it.effect("re-reads the flags before Enter and stops when Claude changed program", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      // Output during the read before Enter means another wait, so the flags are read again.
      for (const changedAt of [2, 3]) {
        const fake = makeFakeClaude({ reactions: GRANTS_REACTIONS });
        let reads = 0;
        const programs = Effect.sync(() => {
          if (++reads === 2 && changedAt === 3) fake.redraw();
          return reads < changedAt ? GRANTED : WEEKLY_SESSION;
        });
        const error = yield* withFake(
          fake,
          readClaudeLimitResets(options(programs), GRANTED_TEXTS).pipe(Effect.flip),
        );
        expect(error.reason).toBe("programChanged");
        expect(reads).toBe(changedAt);
        expect(fake.submitted).toEqual([]);
      }
    }),
  );

  it.effect("presses no Enter onto a dialog that opened after the command was typed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fake = makeFakeClaude({ reactions: GRANTS_REACTIONS });
      let reads = 0;
      const programs = Effect.sync(() => {
        if (++reads === 2) fake.showDialog("/limit-reset weekly");
        return GRANTED;
      });
      const error = yield* withFake(
        fake,
        readClaudeLimitResets(options(programs), GRANTED_TEXTS).pipe(Effect.flip),
      );
      expect(error.reason).toBe("unrecognizedScreen");
      expect(fake.used).toEqual([]);
    }),
  );
});

describe("claimClaudeGrantedReset", () => {
  it.effect("uses the grant only through its dialog's Yes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fake = makeFakeClaude({ reactions: GRANTS_REACTIONS });
      const answer = yield* withFake(
        fake,
        claimClaudeGrantedReset(options(Effect.succeed(GRANTED)), GRANTED_TEXTS, "weekly"),
      );
      expect(answer).toEqual({ _tag: "outcome", outcome: "reset" });
      expect(fake.used).toEqual(["/limit-reset weekly"]);
    }),
  );

  it.effect("checks the account again when output lands during the check before Yes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fake = makeFakeClaude({ reactions: GRANTS_REACTIONS });
      let checks = 0;
      let switched = false;
      // The login switches while a redraw that came during the second check is parsed.
      const holdsAccount = Effect.suspend(() => {
        if (switched) return Effect.fail(new ClaudeLimitResetError({ reason: "accountChanged" }));
        if (++checks === 2) {
          fake.redraw();
          switched = true;
        }
        return Effect.void;
      });
      const error = yield* withFake(
        fake,
        claimClaudeGrantedReset(
          { ...options(Effect.succeed(GRANTED)), holdsAccount },
          GRANTED_TEXTS,
          "weekly",
        ).pipe(Effect.flip),
      );
      expect(error.reason).toBe("accountChanged");
      expect(fake.submitted).toEqual(["/limit-reset weekly"]);
      expect(fake.used).toEqual([]);
    }),
  );

  it.effect("reports a grant Claude no longer offers without opening a dialog", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fake = makeFakeClaude({ reactions: GRANTS_REACTIONS });
      const answer = yield* withFake(
        fake,
        claimClaudeGrantedReset(options(Effect.succeed(GRANTED)), GRANTED_TEXTS, "five_hour"),
      );
      expect(answer).toEqual({ _tag: "outcome", outcome: "noCredit" });
      expect(fake.used).toEqual([]);
    }),
  );
});

describe("claimClaudeWeeklySessionReset", () => {
  it.effect("meets the 5-hour limit with one prompt, then uses the weekly reset", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fake = makeFakeClaude({
        firstRun: ["trust"],
        reactions: {
          hi: { answer: "You've hit your 5-hour limit · resets 5pm" },
          "/limit-reset": {
            answer:
              "5-hour limit reset · next reset available Nov 22 · your weekly limit still applies · send a message to continue",
            uses: true,
          },
        },
      });
      const answer = yield* withFake(
        fake,
        claimClaudeWeeklySessionReset(
          options(Effect.succeed(WEEKLY_SESSION)),
          WEEKLY_SESSION_TEXTS,
        ),
      );
      expect(answer).toEqual({
        _tag: "outcome",
        outcome: "reset",
        weeklySessionAvailableAt: "2026-11-22T00:00:00.000Z",
      });
      expect(fake.submitted).toEqual(["hi", "/limit-reset"]);
    }),
  );
});
