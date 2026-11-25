import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

it.effect(
  "reads a Keychain login only while Cursor's directory exists and Keychain use is on",
  () =>
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
      // Built in the test's scope: the service forks its account refreshes into its layer's scope,
      // so the layer has to stay open while the scans below await them.
      const accounts = yield* Layer.build(
        CursorUsageAccounts.layer.pipe(
          Layer.provide(reader),
          Layer.provide(TestProviderHost.layer()),
        ),
      ).pipe(
        Effect.map((context) => Context.get(context, CursorUsageAccounts.CursorUsageAccounts)),
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
      const keychainOff = yield* accounts.scan({
        keychainUsageEnabled: false,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      });
      expect(keychainOff).toMatchObject([{ action: "enableCursorKeychain" }]);
      expect(reads).toEqual([]);
      expect((yield* scan).map(({ hostId }) => hostId)).toEqual(["cursor.com"]);
      expect(reads).toEqual([{ kind: "keychain" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
