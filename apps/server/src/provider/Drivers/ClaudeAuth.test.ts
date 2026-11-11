import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeClaudeAuth } from "./ClaudeAuth.ts";
import { ClaudeOAuthTokenOutput } from "../claudeOAuthToken.ts";

const instanceId = ProviderInstanceId.make("claudeAgent_personal");
const environment = { PATH: "/tools", CLAUDE_CONFIG_DIR: "/state/home" };

it("redacts every token split, including ANSI styling, repeated tokens and trailing tokens", () => {
  const token = "sk-ant-oat01-synthetic-test-token";
  for (let split = 1; split < token.length; split++) {
    const redactor = new ClaudeOAuthTokenOutput();
    const first = redactor.write(`start ${token.slice(0, split)}`);
    const second = redactor.write(`${token.slice(split)}\x1b[0m\r\nend`);
    const final = redactor.finish();
    assert.equal(first + second + final.output, "start ••••\x1b[0m\r\nend");
    assert.equal(final.token, token);
  }
  const styled = new ClaudeOAuthTokenOutput();
  assert.equal(
    styled.write("sk-ant-\x1b[33moat01-synthetic\x1b[0m-test-token\r\n"),
    "\x1b[33m••••\x1b[0m\r\n",
  );
  assert.equal(styled.write(token), "••••");
  assert.equal(styled.finish().token, token);
});

/** `termsReviews` answers each terms check in turn; checks past the list answer false. */
const makeHarness = (termsReviews: ReadonlyArray<boolean> = [], token?: string) =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const tokens: Array<string | undefined> = [];
    const spawnedInputs: Array<PtyAdapter.PtySpawnInput> = [];
    // Each spawn is ready once its exit listener is attached, so a test's exit reaches it.
    const listeners = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    let data: ((data: string) => void) | undefined;
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let termsChecks = 0;
    const auth = yield* makeClaudeAuth({
      instanceId,
      binaryPath: "claude",
      cwd: "/state",
      environment: token ? { ...environment, CLAUDE_CODE_OAUTH_TOKEN: token } : environment,
      configDir: "/state/home",
      prepare: Effect.sync(() => void events.push("prepare")),
      canLogout: true,
      saveToken: (token) => Effect.sync(() => void tokens.push(token)),
      needsTermsReview: Effect.sync(() => {
        events.push("check terms");
        return termsReviews[termsChecks++] ?? false;
      }),
    }).pipe(
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (input) =>
          Effect.sync(() => {
            events.push(`spawn ${input.args?.join(" ")}`);
            spawnedInputs.push(input);
            return {
              pid: 1,
              write: () => {},
              resize: () => {},
              kill: () => {},
              onData: (callback) => {
                data = callback;
                return () => {};
              },
              onExit: (callback) => {
                exit = callback;
                const listener = listeners[spawnedInputs.length - 1];
                if (listener) Deferred.doneUnsafe(listener, Effect.void);
                return () => {};
              },
            };
          }),
      }),
    );
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      auth.controller
        .subscribe("owner")
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    return {
      auth,
      events,
      spawnedInputs,
      tokens,
      state,
      listening: Deferred.await(listeners[0]!),
      /** Waits for the second Claude run in the sign-in terminal. */
      reviewing: Deferred.await(listeners[1]!),
      print: (value: string) => data?.(value),
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
    };
  });

it.effect("signs the account's own folder in with claude auth login", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.auth.controller.start("owner");
    yield* h.state((value) => value.phase === "waiting");
    assert.deepEqual(h.events, ["prepare", "spawn auth login"]);
    assert.deepEqual(h.spawnedInputs[0], {
      shell: "claude",
      args: ["auth", "login"],
      cwd: "/state",
      cols: 80,
      rows: 24,
      env: environment,
    });
    h.print("Opening browser to sign in…");
    yield* h.state(
      (value) =>
        value.interaction?.type === "terminal" &&
        value.interaction.output.includes("Opening browser"),
    );
    h.exit(0);
    yield* h.state((value) => value.phase === "succeeded");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("opens Claude after sign-in when the account must review Anthropic's terms", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness([true, false]);
    yield* h.auth.controller.start("owner");
    yield* h.listening;
    h.exit(0);
    yield* h.reviewing;
    yield* h.state(
      (value) =>
        value.interaction?.type === "terminal" &&
        value.interaction.output.includes("Consumer Terms"),
    );
    assert.deepEqual(h.spawnedInputs[1]?.args, []);
    assert.deepEqual(h.spawnedInputs[1]?.env, environment);
    h.exit(0);
    yield* h.state((value) => value.phase === "succeeded");
    assert.deepEqual(h.events, [
      "prepare",
      "spawn auth login",
      "check terms",
      "prepare",
      "spawn ",
      "check terms",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails a sign-in whose account still has Anthropic's terms to review", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness([true, true]);
    yield* h.auth.controller.start("owner");
    yield* h.listening;
    h.exit(0);
    yield* h.reviewing;
    h.exit(0);
    const failed = yield* h.state((value) => value.phase === "failed");
    assert.include(failed.message, "Consumer Terms");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a sign-in that Claude did not finish", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.auth.controller.start("owner");
    yield* h.state((value) => value.phase === "waiting");
    h.exit(1);
    const failed = yield* h.state((value) => value.phase === "failed");
    assert.include(failed.message, "Claude sign-in did not finish");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("signs the account's own folder out with claude auth logout", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const logout = yield* h.auth.controller.logout(Effect.void).pipe(Effect.forkScoped);
    yield* h.listening;
    h.exit(0);
    yield* Fiber.join(logout);
    assert.deepEqual(h.events, ["prepare", "spawn auth logout"]);
    assert.deepEqual(h.spawnedInputs[0]?.env, environment);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("offers regular sign-in and token renewal while a token overrides the saved login", () =>
  Effect.gen(function* () {
    const auth = yield* makeClaudeAuth({
      instanceId,
      binaryPath: "claude",
      cwd: "/state",
      environment: { ...environment, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token" },
      configDir: "/state/home",
      prepare: Effect.void,
      canLogout: true,
      saveToken: () => Effect.void,
      needsTermsReview: Effect.succeed(false),
    }).pipe(Effect.provideService(PtyAdapter.PtyAdapter, { spawn: () => Effect.die("spawned") }));
    assert.isTrue(auth.canAuthenticate);
    const ready = yield* auth.controller.subscribe("owner").pipe(
      Stream.filter((state) => state.methods !== undefined),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.deepEqual(
      ready.methods?.map((method) => method.name),
      ["One-year token", "Use regular sign-in instead"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "masks tokens split across PTY chunks before publishing and saves only after success",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const token = "sk-ant-oat01-synthetic-test-token_not-a-real-credential";
      yield* harness.auth.controller.start("owner", Effect.void, "setup-token");
      yield* harness.listening;
      assert.deepEqual(harness.spawnedInputs[0]?.args, ["setup-token"]);
      harness.print("Your OAuth token (valid for 1 year):\r\nsk-ant-");
      const initial = yield* harness.state(
        (state) =>
          state.interaction?.type === "terminal" && state.interaction.output.includes("Your OAuth"),
      );
      assert.notInclude(
        initial.interaction?.type === "terminal" ? initial.interaction.output : "",
        "sk-ant-",
      );
      harness.print("oat01-synthetic-test-");
      harness.print("token_not-a-real-credential\r\nStore this token securely.");
      const masked = yield* harness.state(
        (state) =>
          state.interaction?.type === "terminal" && state.interaction.output.includes("Store this"),
      );
      assert.equal(masked.interaction?.type, "terminal");
      if (masked.interaction?.type === "terminal") {
        assert.include(masked.interaction.output, "••••");
        assert.notInclude(masked.interaction.output, "synthetic");
        assert.notInclude(masked.interaction.output, token);
      }
      assert.deepEqual(harness.tokens, []);
      harness.exit(0);
      yield* harness.state((state) => state.phase === "succeeded");
      assert.deepEqual(harness.tokens, [token]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not save a token from a failed setup or succeed without a token", () =>
  Effect.gen(function* () {
    for (const exitCode of [0, 1]) {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start("owner", Effect.void, "setup-token");
      yield* harness.listening;
      if (exitCode === 1) harness.print("sk-ant-oat01-synthetic-failed-token\r\n");
      harness.exit(exitCode);
      yield* harness.state((state) => state.phase === "failed");
      assert.deepEqual(harness.tokens, []);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "renews token accounts by default and clears their token only after regular sign-in succeeds",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], "sk-ant-oat01-synthetic-old-token");
      yield* harness.auth.controller.start("owner");
      yield* harness.listening;
      assert.deepEqual(harness.spawnedInputs[0]?.args, ["setup-token"]);
      assert.notProperty(harness.spawnedInputs[0]?.env, "CLAUDE_CODE_OAUTH_TOKEN");
      harness.exit(1);
      yield* harness.state((state) => state.phase === "failed");
      assert.deepEqual(harness.tokens, []);
      yield* harness.auth.controller.start("owner", Effect.void, "login");
      yield* harness.reviewing;
      assert.deepEqual(harness.spawnedInputs[1]?.args, ["auth", "login"]);
      assert.deepEqual(harness.spawnedInputs[1]?.env, environment);
      harness.exit(0);
      yield* harness.state((state) => state.phase === "succeeded");
      assert.deepEqual(harness.tokens, [undefined]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves credentials unchanged when token setup is cancelled", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const started = yield* harness.auth.controller.start("owner", Effect.void, "setup-token");
    yield* harness.listening;
    harness.print("sk-ant-oat01-synthetic-cancelled-token\r\n");
    yield* harness.auth.controller.cancel("owner", started.flowId!);
    assert.deepEqual(harness.tokens, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
