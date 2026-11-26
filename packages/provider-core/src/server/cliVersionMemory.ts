import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ProviderHost from "./ProviderHost.ts";

/** Under the provider status cache folder, one file per instance. */
const CLI_VERSIONS_DIR = "cli-versions";
/** Bounds how long closing an instance waits on a hung disk. */
const CLI_VERSION_WRITE_TIMEOUT = "10 seconds";

const CliVersionRecord = Schema.Struct({ driver: Schema.String, version: Schema.String });
const decodeCliVersionRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(CliVersionRecord));

export interface CliVersionMemory {
  /** The version the CLI last reported, kept across restarts; null when it never reported one. */
  readonly lastKnownVersion: Effect.Effect<string | null>;
  /** Runs a status check with `lastKnownVersion`, then keeps the version it reports. */
  readonly check: <A extends { readonly version: string | null }, E, R>(
    run: (lastKnownVersion: string | null) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * What a status check goes on with after `--version`: the output and the version it printed or,
 * when it missed its deadline, no output and the version the instance last reported. Null when it
 * missed its deadline and no version was ever known, which the check reports as a timeout.
 */
export const resolveCliVersion = <
  Output extends { readonly stdout: string; readonly stderr: string },
>(input: {
  /** The CLI's name in the warning, such as "Claude Agent CLI". */
  readonly cli: string;
  /** The `--version` output, None when it missed its deadline. */
  readonly output: Option.Option<Output>;
  readonly lastKnownVersion: string | null;
  readonly parse: (output: string) => string | null;
}): Effect.Effect<{
  readonly output: Output | undefined;
  readonly version: string | null;
} | null> =>
  Option.match(input.output, {
    onSome: (output) =>
      Effect.succeed({ output, version: input.parse(`${output.stdout}\n${output.stderr}`) }),
    onNone: () =>
      input.lastKnownVersion === null
        ? Effect.succeed(null)
        : Effect.logWarning(
            `${input.cli} --version timed out; checking with the version it last reported.`,
            { lastKnownVersion: input.lastKnownVersion },
          ).pipe(Effect.as({ output: undefined, version: input.lastKnownVersion })),
  });

/**
 * Keeps the version in a file of its own: the first check after a restart under load is the one
 * most likely to time out, and until it ends the status cache holds a snapshot without a version.
 */
export const makeCliVersionMemory = Effect.fn("makeCliVersionMemory")(function* (instance: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}): Effect.fn.Return<
  CliVersionMemory,
  never,
  ProviderHost.ProviderHost | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const host = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const filePath = path.join(
    host.paths.providerStatusCacheDir,
    CLI_VERSIONS_DIR,
    `${instance.instanceId}.json`,
  );
  const recorded = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeCliVersionRecord),
    Effect.map((record) => (record.driver === instance.driver ? record.version : null)),
    Effect.catch((error) =>
      error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound"
        ? Effect.succeed(null)
        : Effect.logError("Ignoring an unreadable CLI version record.", {
            path: filePath,
            errorTag: error._tag,
          }).pipe(Effect.as(null)),
    ),
  );
  const known = yield* Ref.make<string | null>(recorded);
  // What the file holds. A failed write leaves it behind `known`, so the next check writes again.
  const persisted = yield* Ref.make<string | null>(recorded);
  const writeLock = yield* Semaphore.make(1);
  // A status check does not wait for the disk, which is slowest when the machine is busiest. Each
  // write takes the newest version when its turn comes, and its fiber cannot be interrupted, so
  // closing the instance waits for a write it started and the file never ends on an older version.
  const writeNewest = Effect.all([Ref.get(known), Ref.get(persisted)]).pipe(
    Effect.flatMap(([version, onDisk]) =>
      version === null || version === onDisk
        ? Effect.void
        : writeFileStringAtomically({
            filePath,
            contents: `${JSON.stringify({ driver: instance.driver, version })}\n`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.timeout(CLI_VERSION_WRITE_TIMEOUT),
            Effect.andThen(Ref.set(persisted, version)),
          ),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("Could not record the CLI version.", {
        path: filePath,
        errorTag: causeErrorTag(cause),
      }),
    ),
    writeLock.withPermits(1),
  );
  const record = (version: string) =>
    Ref.set(known, version).pipe(
      Effect.andThen(Ref.get(persisted)),
      Effect.flatMap((onDisk) =>
        onDisk === version
          ? Effect.void
          : writeNewest.pipe(Effect.forkIn(scope, { uninterruptible: true }), Effect.asVoid),
      ),
    );
  return {
    lastKnownVersion: Ref.get(known),
    check: (run) =>
      Ref.get(known).pipe(
        Effect.flatMap(run),
        Effect.tap((snapshot) =>
          snapshot.version === null ? Effect.void : record(snapshot.version),
        ),
      ),
  };
});
