import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  makePersistedServerRuntimeState,
  PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";

const encodeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

/** What a server the service started does once it serves: publish its runtime state. */
export const publishServer = (
  fs: FileSystem.FileSystem,
  baseDir: string,
  ownerId = "started-server",
) =>
  Effect.gen(function* () {
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3773,
    });
    yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
    yield* fs.writeFileString(
      `${baseDir}/userdata/server-runtime.json`,
      yield* encodeState({ ...state, ownerId }),
    );
  }).pipe(Effect.orDie);
