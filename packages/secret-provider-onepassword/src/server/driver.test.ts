// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";

import { OnePasswordAccount } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const account = OnePasswordAccount.make("my.1password.com");
const serviceAccount = { auth: "linux-service-account" } as const;

type OpResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
  readonly delay?: Duration.Input;
};

function fakeOp(answer: (args: ReadonlyArray<string>) => OpResult) {
  const invocations: Array<ReadonlyArray<string>> = [];
  const commands: Array<ChildProcess.StandardCommand> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
          const { args } = command;
          invocations.push(args);
          commands.push(command);
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: result.hang
              ? Effect.never
              : Effect.sleep(result.delay ?? 0).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(result.code ?? 0)),
                ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    NodeFileSystem.layer,
    NodeCrypto.layer,
  );
  return { layer, invocations, commands, spawned };
}

// Answers `op inject` by substituting each `{{ reference }}` in the template file it was handed.
const injectFrom =
  (secrets: Readonly<Record<string, string>>) =>
  (args: ReadonlyArray<string>): OpResult => {
    const template = NodeFS.readFileSync(args[args.indexOf("-i") + 1]!, "utf8");
    return { stdout: template.replace(/\{\{ (\S+) \}\}/g, (_, reference) => secrets[reference]!) };
  };

describe("1Password driver", () => {
  it.effect("reads one reference from the account", () => {
    const op = fakeOp(() => ({ stdout: "sk-live" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        "sk-live",
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "read",
          "--account=my.1password.com",
          "--no-newline",
          "op://Private/OpenAI/credential",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a failed reference as undefined", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] account is locked" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        undefined,
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads every reference in a single call", () => {
    const op = fakeOp(
      injectFrom({
        "op://Private/OpenAI/credential": "sk-a",
        "op://Private/Anthropic/key": " sk-b\n",
      }),
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Anthropic/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", " sk-b\n"]);
      assert.strictEqual(op.invocations.length, 1);
      assert.deepStrictEqual(op.invocations[0]?.slice(0, 3), [
        "--cache=false",
        "inject",
        "--account=my.1password.com",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("falls back to one read at a time when the batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, stderr: '[ERROR] could not resolve "op://Private/Gone/key"' }
        : args.at(-1) === "op://Private/Gone/key"
          ? { code: 1, stderr: "[ERROR] item not found" }
          : { stdout: "sk-a" },
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Gone/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", undefined]);
      assert.strictEqual(op.invocations.length, 3);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("does not read one at a time after the batch times out", () => {
    const op = fakeOp(() => ({ hang: true }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(op.spawned);
      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual(yield* Fiber.join(reading), [undefined, undefined]);
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("gives up within the read timeout when a slow batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, delay: "40 seconds" }
        : { stdout: "sk-a", delay: "40 seconds" },
    );
    // Keeps the temp template off real disk I/O so the virtual clock alone drives the read.
    const templateFile = FileSystem.layerNoop({
      makeTempFileScoped: () => Effect.succeed("/template"),
      writeFileString: () => Effect.void,
    });
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.andThen(Clock.currentTimeMillis), Effect.forkChild);
      yield* TestClock.adjust("5 minutes");

      assert.isAtMost(yield* Fiber.join(reading), 45_000);
    }).pipe(Effect.provide(Layer.merge(op.layer, templateFile)));
  });

  it.effect("reads each Linux service account reference with an isolated sudo invocation", () => {
    const references = ["op://CodeShip/OpenAI/key", "op://CodeShip/Anthropic/key"];
    const op = fakeOp((args) => ({
      stdout: args.at(-1) === references[0] ? " first\n" : "second",
    }));

    return Effect.gen(function* () {
      const values = yield* driver.read(serviceAccount, references);

      assert.deepStrictEqual(values, [" first\n", "second"]);
      assert.deepStrictEqual(
        op.commands.map(({ command, args, options }) => ({ command, args, options })),
        references.map((reference) => ({
          command: "/usr/bin/sudo",
          args: [
            "-n",
            "-u",
            "codeship-op",
            "--",
            "/usr/bin/op",
            "--cache=false",
            "read",
            "--no-newline",
            reference,
          ],
          options: { cwd: "/", env: {}, extendEnv: false, shell: false },
        })),
      );
    }).pipe(Effect.provide(op.layer), Effect.provideService(HostProcess.Platform, "linux"));
  });

  it.effect("leaves denied or invalid Linux service account reads unresolved", () => {
    const op = fakeOp(() => ({ code: 1, stdout: "partial-value", stderr: "private-error" }));
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => messages.push(message));
    const deniedReference = "op://CodeShip/OpenAI/key";

    return Effect.gen(function* () {
      const values = yield* driver.read(serviceAccount, [
        deniedReference,
        "op://CodeShip/Open AI/key",
        "op://CodeShip/OpenAI/key?attribute=otp",
        "--version",
      ]);

      assert.deepStrictEqual(values, [undefined, undefined, undefined, undefined]);
      assert.deepStrictEqual(
        op.invocations.map((args) => args.at(-1)),
        [deniedReference],
      );
      assert.include(JSON.stringify(messages), "Could not read secret from 1Password");
      assert.notInclude(JSON.stringify(messages), deniedReference);
      assert.notInclude(JSON.stringify(messages), "partial-value");
      assert.notInclude(JSON.stringify(messages), "private-error");
    }).pipe(
      Effect.provide(Layer.merge(op.layer, Logger.layer([logger], { mergeWithExisting: false }))),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
  });

  it.effect("leaves service account reads unresolved outside Linux", () => {
    const op = fakeOp(() => ({ stdout: "unexpected" }));

    return Effect.gen(function* () {
      const values = yield* driver.read(serviceAccount, ["op://CodeShip/OpenAI/key"]);

      assert.deepStrictEqual(values, [undefined]);
      assert.isEmpty(op.invocations);
    }).pipe(Effect.provide(op.layer), Effect.provideService(HostProcess.Platform, "darwin"));
  });
});
