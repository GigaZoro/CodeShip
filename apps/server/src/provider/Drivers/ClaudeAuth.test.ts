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

const instanceId = ProviderInstanceId.make("claudeAgent_personal");
const environment = { PATH: "/tools", CLAUDE_CONFIG_DIR: "/state/home" };

const makeHarness = Effect.gen(function* () {
  const events: Array<string> = [];
  const spawnedInputs: Array<PtyAdapter.PtySpawnInput> = [];
  // Ready once the exit listener is attached, so a test's exit reaches it.
  const listening = yield* Deferred.make<void>();
  let data: ((data: string) => void) | undefined;
  let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
  const auth = yield* makeClaudeAuth({
    instanceId,
    binaryPath: "claude",
    cwd: "/state",
    environment,
    configDir: "/state/home",
    prepare: Effect.sync(() => void events.push("prepare")),
    canLogout: true,
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
              Deferred.doneUnsafe(listening, Effect.void);
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
    state,
    listening: Deferred.await(listening),
    print: (value: string) => data?.(value),
    exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
  };
});

it.effect("signs the account's own folder in with claude auth login", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
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

it.effect("reports a sign-in that Claude did not finish", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.auth.controller.start("owner");
    yield* h.state((value) => value.phase === "waiting");
    h.exit(1);
    const failed = yield* h.state((value) => value.phase === "failed");
    assert.include(failed.message, "Claude sign-in did not finish");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("signs the account's own folder out with claude auth logout", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const logout = yield* h.auth.controller.logout(Effect.void).pipe(Effect.forkScoped);
    yield* h.listening;
    h.exit(0);
    yield* Fiber.join(logout);
    assert.deepEqual(h.events, ["prepare", "spawn auth logout"]);
    assert.deepEqual(h.spawnedInputs[0]?.env, environment);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
