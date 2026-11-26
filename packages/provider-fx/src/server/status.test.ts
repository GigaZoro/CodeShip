import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { FxSettings } from "../settings.ts";
import { checkFxProviderStatus } from "./status.ts";
import { makeFxMaintenanceResolver } from "./maintenance.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(FxSettings)({ enabled: true });

/** Holds stdout and the exit back until `answered` completes, like a CLI slow to answer. */
function processHandle(stdout: string, code: number, answered: Effect.Effect<void> = Effect.void) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_101),
    exitCode: Effect.as(answered, ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.unwrap(
      Effect.as(
        answered,
        stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(stdout)),
      ),
    ),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Answers `fx` invocations by their arguments and records which ran. */
const check = (
  statusJson: string,
  versionDelay: Duration.Input = 0,
  lastKnownVersion: string | null = null,
) =>
  Effect.gen(function* () {
    const outputs: Record<string, string> = {
      "--version": "fx 0.0.13\n",
      "status --json": statusJson,
      // `fx models --json` from fx 0.0.13, ids trimmed.
      "models --json": JSON.stringify({
        kind: "models",
        count: 2,
        shown_count: 2,
        more_count: 0,
        private_models_hidden: false,
        ids: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"],
      }),
    };
    const invoked: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
      invoked.push(args);
      const stdout = outputs[args];
      return Effect.succeed(
        processHandle(
          stdout ?? "",
          stdout === undefined ? 2 : 0,
          args === "--version" ? Effect.sleep(versionDelay) : Effect.void,
        ),
      );
    });
    const draft = yield* checkFxProviderStatus(settings, {}, lastKnownVersion).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return { draft, invoked };
  }).pipe(Effect.provide(NodeServices.layer));

it.effect.each([
  { name: "native stable", owner: "native", updateChannel: "stable", canUpdate: true },
  { name: "native dev", owner: "native", updateChannel: "dev", canUpdate: false },
  {
    name: "development build on the stable update channel",
    owner: "native",
    updateChannel: "stable",
    buildChannel: "dev",
    canUpdate: false,
  },
  { name: "package-managed", owner: "package", updateChannel: "stable", canUpdate: false },
  {
    name: "symlink to package-managed fx",
    owner: "symlink",
    updateChannel: "stable",
    canUpdate: false,
  },
])("reports canUpdate=$canUpdate for $name installations", (row) =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        processHandle(
          JSON.stringify({ update_channel: row.updateChannel, build_channel: row.buildChannel }),
          0,
        ),
      ),
    );
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("v0.0.17\n"))),
    );
    const path = yield* Path.Path;
    const home = path.resolve("test-fx-home");
    const native = path.join(home, ".local", "bin", "fx");
    const packaged = path.join(home, "mise", "installs", "fx", "0.0.16", "fx");
    const capabilities = yield* makeFxMaintenanceResolver(client)
      .resolve({
        binaryPath: "fx",
        resolvedCommandPath: row.owner === "package" ? packaged : native,
        realCommandPath: row.owner === "native" ? native : packaged,
        env: { HOME: home },
        platform: "darwin",
      })
      .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    if (row.canUpdate) {
      assert.deepEqual(capabilities.update?.args, ["upgrade"]);
      assert.equal(capabilities.update?.executable, native);
      assert.equal(yield* capabilities.lookupLatestVersion!, "0.0.17");
    } else {
      assert.isNull(capabilities.update);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("checkFxProviderStatus", () => {
  it.effect.each([
    {
      label: "answers after 6 s",
      versionDelay: "6 seconds",
      status: "ready",
      version: "0.0.13",
      message: undefined,
      invoked: ["--version", "status --json", "models --json"],
      lastKnownVersion: null,
    },
    {
      label: "never answers after a version was known",
      versionDelay: "Infinity",
      status: "ready",
      version: "0.0.12",
      message: undefined,
      invoked: ["--version", "status --json", "models --json"],
      lastKnownVersion: "0.0.12",
    },
    {
      label: "never answers and no version is known",
      versionDelay: "Infinity",
      status: "error",
      version: null,
      message: "fx did not answer `fx --version` within 10s.",
      invoked: ["--version"],
      lastKnownVersion: null,
    },
  ] as const)("gives `fx --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      const fiber = yield* check(
        JSON.stringify({ kind: "status", model: "anthropic/claude-opus-5.5", auth: "fx login" }),
        row.versionDelay,
        row.lastKnownVersion,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const { draft, invoked } = yield* Fiber.join(fiber);
      assert.equal(draft.status, row.status);
      assert.equal(draft.version, row.version);
      assert.equal(draft.message, row.message);
      assert.deepEqual(invoked, [...row.invoked]);
    }),
  );

  // `fx status --json` from fx 0.0.13, trimmed to the fields T3 reads plus a few it ignores.
  it.effect("reports sign-in from `fx status` without opening an ACP session", () =>
    Effect.gen(function* () {
      const signedIn = yield* check(
        JSON.stringify({
          kind: "status",
          model: "anthropic/claude-opus-5.5",
          auth: "fx login",
          auth_refreshable: true,
          permission_mode: "ask",
        }),
      );
      assert.deepEqual(signedIn.invoked, ["--version", "status --json", "models --json"]);
      assert.equal(signedIn.draft.status, "ready");
      assert.equal(signedIn.draft.version, "0.0.13");
      assert.deepEqual(signedIn.draft.auth, { status: "authenticated", label: "fx login" });
      assert.deepEqual(
        signedIn.draft.models.map((model) => model.slug),
        ["default", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"],
      );
      // "Default" carries the model `fx status` reports, which the adapter selects for it.
      assert.deepEqual(signedIn.draft.models[0]?.aliases, ["anthropic/claude-opus-5.5"]);
      assert.isDefined(signedIn.draft.versionAdvisory);

      const signedOut = yield* check(
        JSON.stringify({
          kind: "status",
          model: "spacexai/grok-4.7",
          auth: "missing",
          auth_refreshable: false,
          auth_help:
            "fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.",
        }),
      );
      assert.equal(signedOut.draft.status, "error");
      assert.equal(signedOut.draft.auth.status, "unauthenticated");
      assert.equal(signedOut.draft.message, "Run `fx login` to sign in.");

      // An fx whose status output T3 cannot read is not reported as signed out.
      const unknown = yield* check("not json");
      assert.equal(unknown.draft.status, "warning");
      assert.equal(unknown.draft.auth.status, "unknown");
    }),
  );
});
