import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

it.effect("gives no source for a valid Keychain login while Cursor's directory is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const reads: unknown[] = [];
    const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
      read: (credential) =>
        Effect.sync(() => {
          reads.push(credential);
          return { accountKey: "account-a", records: [], missing: false, error: null };
        }),
    });
    const accounts = yield* CursorUsageAccounts.CursorUsageAccounts.pipe(
      Effect.provide(
        CursorUsageAccounts.layer.pipe(
          Layer.provide(reader),
          Layer.provide(TestProviderHost.layer()),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, { HOME: home }),
    );
    const scan = accounts.scan({
      keychainUsageEnabled: true,
      windowStartMs: 0,
      retentionCutoffMs: 0,
      awaitRefresh: true,
    });

    expect(yield* scan).toEqual([]);
    expect(reads).toEqual([]);

    yield* fs.makeDirectory(path.join(home, ".cursor"));
    expect((yield* scan).map(({ hostId }) => hostId)).toEqual(["cursor.com"]);
    expect(reads).toEqual([{ kind: "keychain" }]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
