import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  type ClaudeMcpRenewalAttempt,
  parseClaudeMcpSignIns,
  planClaudeMcpRenewals,
  makeClaudeMcpSignInRenewal,
} from "./ClaudeMcpSignInRenewal.ts";

const MINUTE = 60_000;
const url = "https://thread.page/mcp";
const signIn = { serverName: "threadpage", serverUrl: url, expiresAt: 60 * MINUTE };

describe("parseClaudeMcpSignIns", () => {
  it("keeps the sign-ins Claude can still renew, without their tokens", () => {
    const document = JSON.stringify({
      claudeAiOauth: { accessToken: "login-access", refreshToken: "login-refresh" },
      mcpOAuth: {
        "threadpage|abc": { ...signIn, accessToken: "access", refreshToken: "refresh" },
        // What Claude saves once a renewal is refused.
        "minions|def": { serverName: "minions", serverUrl: url, accessToken: "", expiresAt: 0 },
        "no-expiry|ghi": { serverName: "no-expiry", serverUrl: url, refreshToken: "refresh" },
        "broken|jkl": "not a record",
      },
    });
    assert.deepStrictEqual(parseClaudeMcpSignIns(document), [signIn]);
  });
});

describe("planClaudeMcpRenewals", () => {
  it("renews in Claude's last minutes while the old token works, and spaces out retries", () => {
    const configured = new Map([["threadpage", url]]);
    const failedAt = (at: number) =>
      new Map<string, ClaudeMcpRenewalAttempt>([
        ["threadpage", { expiresAt: signIn.expiresAt, at }],
      ]);
    const cases: ReadonlyArray<{
      readonly nowMs: number;
      readonly configured?: ReadonlyMap<string, string>;
      readonly attempts?: ReadonlyMap<string, ClaudeMcpRenewalAttempt>;
      readonly due: boolean;
      readonly nextCheckAt?: number;
    }> = [
      { nowMs: 50 * MINUTE, due: false, nextCheckAt: 51 * MINUTE },
      { nowMs: 55.5 * MINUTE, due: false, nextCheckAt: 56 * MINUTE },
      { nowMs: 56 * MINUTE, due: true },
      { nowMs: 90 * MINUTE, due: true },
      // A sign-in kept for a server since removed or moved.
      { nowMs: 59 * MINUTE, configured: new Map(), due: false },
      { nowMs: 59 * MINUTE, configured: new Map([["threadpage", "https://old/mcp"]]), due: false },
      // A renewal that left the expiry as it was failed: retried each minute, then each 15 once expired.
      {
        nowMs: 56.5 * MINUTE,
        attempts: failedAt(56 * MINUTE),
        due: false,
        nextCheckAt: 57 * MINUTE,
      },
      { nowMs: 57 * MINUTE, attempts: failedAt(56 * MINUTE), due: true },
      { nowMs: 70 * MINUTE, attempts: failedAt(60 * MINUTE), due: false },
      { nowMs: 75 * MINUTE, attempts: failedAt(60 * MINUTE), due: true },
      // A server whose tokens last under four minutes is not renewed more than once a minute.
      {
        nowMs: 56.5 * MINUTE,
        attempts: new Map([["threadpage", { expiresAt: 0, at: 56 * MINUTE }]]),
        due: false,
      },
    ];
    const stale = { ...signIn, expiresAt: 10 * MINUTE };
    assert.deepStrictEqual(
      planClaudeMcpRenewals({
        signIns: [stale, signIn],
        configured,
        attempts: new Map(),
        nowMs: 30 * MINUTE,
      }).due,
      [],
    );
    for (const testCase of cases) {
      const plan = planClaudeMcpRenewals({
        signIns: [signIn],
        configured: testCase.configured ?? configured,
        attempts: testCase.attempts ?? new Map(),
        nowMs: testCase.nowMs,
      });
      assert.deepStrictEqual(plan.due, testCase.due ? [signIn] : [], `${testCase.nowMs}`);
      if (testCase.nextCheckAt !== undefined) {
        assert.strictEqual(plan.nextCheckAt, testCase.nextCheckAt, `${testCase.nowMs}`);
      }
    }
  });
});

describe("makeClaudeMcpSignInRenewal", () => {
  it.effect("has Claude renew each sign-in four minutes before it expires", () =>
    Effect.gen(function* () {
      let expiresAt = signIn.expiresAt;
      let reads = 0;
      const renewedAt = yield* Queue.unbounded<number>();
      yield* makeClaudeMcpSignInRenewal({
        storeKey: "renews-ahead",
        readSignIns: Effect.suspend(() =>
          // A read that dies once must not stop later renewals.
          ++reads === 2 ? Effect.die("unreadable") : Effect.succeed([{ ...signIn, expiresAt }]),
        ),
        readConfigured: Effect.succeed(new Map([["threadpage", url]])),
        renew: () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => {
              expiresAt = now + 60 * MINUTE;
              return Queue.offer(renewedAt, now);
            }),
            Effect.asVoid,
          ),
      });

      yield* TestClock.adjust("56 minutes");
      assert.strictEqual(yield* Queue.take(renewedAt), 56 * MINUTE);
      yield* TestClock.adjust("56 minutes");
      assert.strictEqual(yield* Queue.take(renewedAt), 112 * MINUTE);
    }),
  );

  it.effect("has chats that start together wait for one renewal of an expired sign-in", () =>
    Effect.gen(function* () {
      let renewals = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const renewal = yield* makeClaudeMcpSignInRenewal({
        storeKey: "burst",
        readSignIns: Effect.succeed([{ ...signIn, expiresAt: -MINUTE }]),
        readConfigured: Effect.succeed(new Map([["threadpage", url]])),
        renew: () =>
          Effect.sync(() => renewals++).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
      });

      const chats = yield* Effect.forEach([1, 2], () => Effect.forkScoped(renewal.ensureFresh));
      yield* Deferred.await(started);
      for (const chat of chats) assert.isUndefined(chat.pollUnsafe());
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(chats, Fiber.join);
      assert.strictEqual(renewals, 1);
    }),
  );

  it.effect("lets a renewal finish across a provider rebuild, which joins it", () =>
    Effect.gen(function* () {
      let renewals = 0;
      let expiresAt = signIn.expiresAt;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const outcome = yield* Deferred.make<"finished" | "interrupted">();
      const make = makeClaudeMcpSignInRenewal({
        storeKey: "rebuild",
        readSignIns: Effect.sync(() => [{ ...signIn, expiresAt }]),
        readConfigured: Effect.succeed(new Map([["threadpage", url]])),
        renew: () =>
          Effect.sync(() => renewals++).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => (expiresAt += 60 * MINUTE))),
            Effect.andThen(Deferred.succeed(outcome, "finished")),
            Effect.onInterrupt(() => Deferred.succeed(outcome, "interrupted")),
            Effect.asVoid,
          ),
      });
      const before = yield* Scope.make();
      yield* make.pipe(Scope.provide(before));

      yield* TestClock.adjust("56 minutes");
      yield* Deferred.await(started);
      yield* Scope.close(before, Exit.void);
      const rebuilt = yield* make;
      // The rebuilt provider's loop finds the sign-in due again and must join the running renewal.
      yield* TestClock.adjust("1 minute");
      const chatStarted = yield* Deferred.make<void>();
      const chat = yield* Effect.forkScoped(
        Deferred.succeed(chatStarted, undefined).pipe(
          Effect.andThen(rebuilt.ensureFresh),
          Effect.andThen(Deferred.isDone(outcome)),
        ),
      );
      yield* Deferred.await(chatStarted);
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(yield* Fiber.join(chat));
      assert.strictEqual(yield* Deferred.await(outcome), "finished");
      assert.strictEqual(renewals, 1);
    }),
  );
});
