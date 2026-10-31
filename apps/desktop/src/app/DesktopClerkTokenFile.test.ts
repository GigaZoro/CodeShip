import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopClerkTokenFile from "./DesktopClerkTokenFile.ts";

const KEY = "__clerk_client_jwt";

describe("DesktopClerkTokenFile", () => {
  it.effect("keeps tokens across launches in a file only the user can read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-clerk-tokens-" });
      const filePath = path.join(stateDir, "clerk-tokens.json");
      // Left by an earlier build whose Keychain key this one cannot use.
      yield* fileSystem.writeFileString(filePath, JSON.stringify({ [KEY]: "enc:c2VjcmV0" }));
      yield* fileSystem.chmod(filePath, 0o666);

      const firstLaunch = DesktopClerkTokenFile.make(stateDir);
      assert.isNull(yield* Effect.promise(async () => firstLaunch.getItem(KEY)));
      yield* Effect.promise(async () => firstLaunch.setItem(KEY, "client-jwt"));

      const nextLaunch = DesktopClerkTokenFile.make(stateDir);
      assert.equal(yield* Effect.promise(async () => nextLaunch.getItem(KEY)), "client-jwt");
      // Clerk's own storage() reads this format, so a later Team ID build stays signed in.
      assert.deepEqual(JSON.parse(yield* fileSystem.readFileString(filePath)), {
        [KEY]: "raw:client-jwt",
      });
      // Windows reports no POSIX permission bits.
      if ((yield* HostProcess.Platform) !== "win32") {
        assert.equal((yield* fileSystem.stat(filePath)).mode & 0o777, 0o600);
      }

      yield* Effect.promise(async () => nextLaunch.removeItem(KEY));
      assert.isNull(
        yield* Effect.promise(async () => DesktopClerkTokenFile.make(stateDir).getItem(KEY)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
