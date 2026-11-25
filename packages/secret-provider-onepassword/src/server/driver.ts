import { spawnAndCollect, type CommandResult } from "@t3tools/provider-core/server/snapshotProbe";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/process";

import {
  definition,
  isOnePasswordLinuxServiceAccountReference,
  type OnePasswordAccount,
} from "../shared/definition.ts";

const ONE_PASSWORD_BINARY = "op";
const SUDO_BINARY = "/usr/bin/sudo";
// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
const runOnePassword = Effect.fn("OnePasswordDriver.runOnePassword")(function* (
  args: ReadonlyArray<string>,
) {
  const spawnCommand = yield* resolveSpawnCommand(ONE_PASSWORD_BINARY, ["--cache=false", ...args]);
  return yield* spawnAndCollect(
    ONE_PASSWORD_BINARY,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, { shell: spawnCommand.shell }),
  );
});

// A secret is passed on verbatim; surrounding whitespace can be part of it.
const nonEmpty = (value: string) => (value.trim().length > 0 ? value : undefined);

const readValue = Effect.fn("OnePasswordDriver.readValue")(function* (result: CommandResult) {
  if (result.code !== 0) {
    yield* Effect.logWarning("Could not read secret from 1Password", {
      stage: "read",
      exitCode: result.code,
    });
    return undefined;
  }
  return nonEmpty(result.stdout);
});

const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
  account: OnePasswordAccount,
  reference: string,
) {
  return yield* readValue(
    yield* runOnePassword(["read", `--account=${account}`, "--no-newline", reference]),
  );
});

const readWithServiceAccount = Effect.fn("OnePasswordDriver.readWithServiceAccount")(function* (
  reference: string,
) {
  if (!isOnePasswordLinuxServiceAccountReference(reference)) return;
  // Only the exact per-field command may receive the credential from sudo policy.
  const result = yield* spawnAndCollect(
    SUDO_BINARY,
    ChildProcess.make(
      SUDO_BINARY,
      [
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
      { cwd: "/", env: {}, extendEnv: false, shell: false },
    ),
  );
  return yield* readValue(result);
});

// One `op inject` costs one unlock for every reference in the template. `op` ignores piped stdin
// from Node, so the template goes through a temp file. A random separator after every reference
// keeps one secret from shifting the others, and leaves any trailing newline outside the values.
const readTogether = Effect.fn("OnePasswordDriver.readTogether")(function* (
  account: OnePasswordAccount,
  references: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const separator = `__t3-secret-${yield* (yield* SecureRandom.SecureRandom).uuidV4()}__`;
  const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
  yield* fileSystem.writeFileString(
    templatePath,
    references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
  );
  const result = yield* runOnePassword(["inject", `--account=${account}`, "-i", templatePath]);
  const values = result.stdout.split(separator);
  const trailing = values.pop();
  if (
    result.code !== 0 ||
    values.length !== references.length ||
    trailing === undefined ||
    trailing.trim().length > 0
  ) {
    yield* Effect.logWarning("Could not batch-read secrets from 1Password", {
      stage: "inject",
      exitCode: result.code,
      references: references.length,
    });
    return undefined;
  }
  return values.map(nonEmpty);
}, Effect.scoped);

const recover = <A, E extends { readonly _tag: string }, R>(
  stage: "read" | "inject",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  unattended: (config) => config.auth === "linux-service-account",
  read: Effect.fn("OnePasswordDriver.read")(function* (config, references) {
    const account = config.auth === "linux-service-account" ? undefined : config.account;
    if (account === undefined && (yield* HostProcess.Platform) !== "linux") {
      yield* Effect.logWarning("1Password service account reads require Linux");
      return references.map(() => undefined);
    }
    // One deadline covers the batch and the fallback; a reference not read by then is unreadable.
    const values: Array<string | undefined> = references.map(() => undefined);
    const outcome = yield* Effect.gen(function* () {
      if (account !== undefined && references.length > 1) {
        const together = yield* recover("inject", readTogether(account, references));
        if (together !== undefined) return together;
      }
      yield* Effect.forEach(
        references,
        (reference, index) =>
          (account === undefined
            ? recover("read", readWithServiceAccount(reference))
            : recover("read", readOne(account, reference))
          ).pipe(
            Effect.map((value) => {
              values[index] = value;
            }),
          ),
        { discard: true },
      );
      return values;
    }).pipe(Effect.timeoutOption(READ_TIMEOUT));
    if (Option.isSome(outcome)) return outcome.value;
    yield* Effect.logWarning("1Password did not answer in time", {
      references: references.length,
    });
    return values;
  }),
});
