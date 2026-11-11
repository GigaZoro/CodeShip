import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";

import {
  claudeKeychainService,
  parseClaudeLoginExpiry,
  readClaudeLoginExpiry,
} from "./claudeLoginExpiry.ts";

const REFRESH_EXPIRES_AT = Date.parse("2026-12-01T02:46:43.298Z");
const login = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });
const TOKEN = "sk-ant-oat01-do-not-leak";

describe("claudeKeychainService", () => {
  // Matches the items Claude Code wrote on the maintainer's Mac.
  it("suffixes the config folder's SHA-256 prefix and leaves the default folder bare", () => {
    assert.equal(claudeKeychainService(undefined), "Claude Code-credentials");
    assert.equal(claudeKeychainService("  "), "Claude Code-credentials");
    assert.equal(
      claudeKeychainService(
        "/Users/zoro/.t3/userdata/providers/claudeAgent/claudeAgent_akucheri/home",
      ),
      "Claude Code-credentials-7a4b560f",
    );
    assert.equal(
      claudeKeychainService(
        "/Users/zoro/.t3/userdata/providers/claudeAgent/claudeAgent_vitalii/home",
      ),
      "Claude Code-credentials-09f2d20b",
    );
  });
});

describe("parseClaudeLoginExpiry", () => {
  it("keeps only the refresh token's expiry, as an ISO date", () => {
    assert.equal(
      parseClaudeLoginExpiry(
        login({
          accessToken: TOKEN,
          refreshToken: TOKEN,
          expiresAt: 1,
          refreshTokenExpiresAt: REFRESH_EXPIRES_AT,
        }),
      ),
      "2026-12-01T02:46:43.298Z",
    );
  });

  it("reads no date from a login without one, or from something that is not a login", () => {
    assert.equal(parseClaudeLoginExpiry(login({ accessToken: TOKEN, expiresAt: 5 })), undefined);
    assert.equal(parseClaudeLoginExpiry(login({ refreshTokenExpiresAt: 0 })), undefined);
    assert.equal(parseClaudeLoginExpiry(login({ refreshTokenExpiresAt: "soon" })), undefined);
    assert.equal(parseClaudeLoginExpiry('{"mcpOAuth":{}}'), undefined);
    assert.equal(parseClaudeLoginExpiry("not json"), undefined);
  });
});

const keychain = (reply: { readonly stdout: string; readonly code: number } | "hang") => {
  const requests: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "ChildProcess",
          method: "spawn",
          description: "Only `security` is stubbed.",
        }),
      );
    }
    requests.push([command.command, ...command.args]);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_301),
        exitCode:
          reply === "hang"
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(reply.code)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: reply === "hang" ? Stream.never : Stream.encodeText(Stream.make(reply.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, requests };
};

const platform = (value: NodeJS.Platform) => Layer.succeed(HostProcess.Platform, value);

const withConfigDir = <A, E, R>(use: (configDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* use(yield* fileSystem.makeTempDirectoryScoped());
  });

const read = (input: {
  readonly configDir: string;
  readonly claudeConfigDirEnv?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly os: NodeJS.Platform;
}) =>
  readClaudeLoginExpiry({
    configDir: input.configDir,
    claudeConfigDirEnv: input.claudeConfigDirEnv,
    environment: input.environment ?? {},
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    Effect.provide(platform(input.os)),
  );

describe("readClaudeLoginExpiry", () => {
  it.effect("reads the Keychain item named for the config folder on macOS", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const { spawner, requests } = keychain({
          stdout: login({ accessToken: TOKEN, refreshTokenExpiresAt: REFRESH_EXPIRES_AT }),
          code: 0,
        });
        const expiry = yield* read({
          configDir,
          claudeConfigDirEnv: configDir,
          spawner,
          os: "darwin",
        });
        assert.equal(expiry, "2026-12-01T02:46:43.298Z");
        assert.deepEqual(requests, [
          ["security", "find-generic-password", "-s", claudeKeychainService(configDir), "-w"],
        ]);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the login file when the Keychain has no item", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(configDir, ".credentials.json"),
          login({ refreshTokenExpiresAt: REFRESH_EXPIRES_AT }),
        );
        const { spawner } = keychain({ stdout: "", code: 44 });
        assert.equal(yield* read({ configDir, spawner, os: "darwin" }), "2026-12-01T02:46:43.298Z");
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("trusts the Keychain record over an older login file, even without an expiry", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(configDir, ".credentials.json"),
          login({ refreshTokenExpiresAt: Date.parse("2026-01-01T00:00:00.000Z") }),
        );
        const { spawner } = keychain({ stdout: login({ accessToken: TOKEN }), code: 0 });
        assert.equal(yield* read({ configDir, spawner, os: "darwin" }), undefined);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the login file on other systems without running anything", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(configDir, ".credentials.json"),
          login({ refreshTokenExpiresAt: REFRESH_EXPIRES_AT }),
        );
        const { spawner, requests } = keychain({ stdout: "", code: 1 });
        assert.equal(yield* read({ configDir, spawner, os: "linux" }), "2026-12-01T02:46:43.298Z");
        assert.deepEqual(requests, []);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is unknown, not an error, when the item is missing or the read hangs", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const missing = keychain({ stdout: "", code: 44 });
        assert.equal(yield* read({ configDir, spawner: missing.spawner, os: "darwin" }), undefined);

        const hanging = keychain("hang");
        const fiber = yield* read({ configDir, spawner: hanging.spawner, os: "darwin" }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Fiber.join(fiber), undefined);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("has no date to read when a long-lived token is the login", () =>
    withConfigDir((configDir) =>
      Effect.gen(function* () {
        const { spawner, requests } = keychain({
          stdout: login({ refreshTokenExpiresAt: REFRESH_EXPIRES_AT }),
          code: 0,
        });
        const expiry = yield* read({
          configDir,
          spawner,
          os: "darwin",
          environment: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
        });
        assert.equal(expiry, undefined);
        assert.deepEqual(requests, []);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
