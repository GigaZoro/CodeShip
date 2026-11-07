import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const AppPackageMetadata = Schema.Struct({
  t3codeAppleTeamSigned: Schema.optional(Schema.Boolean),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

/**
 * The Keychain recognizes an app across updates only by its Apple Team ID, so builds without one
 * get a Keychain prompt after every update. They keep secrets in owner-only files instead.
 */
export const forgetsUpdates = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin" || !environment.isPackaged) return false;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(environment.appRoot, "package.json")).pipe(
    Effect.flatMap(decodeAppPackageMetadata),
    Effect.map((metadata) => metadata.t3codeAppleTeamSigned === false),
    Effect.orElseSucceed(() => false),
  );
}).pipe(Effect.withSpan("DesktopKeychain.forgetsUpdates"));
