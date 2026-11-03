import { DESKTOP_UPDATE_RESUME_THREADS_MARKER_FILE } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { RestartResumeRequest } from "../orchestration-v2/RestartContinuation.ts";

// Covers the old server's shutdown, a slow install and startup, and the continuation start retries.
const MARKER_TTL = Duration.minutes(15);

/** The desktop writes the marker before a safe update stops this server and removes it if the install fails. */
export const layer = Layer.effect(
  RestartResumeRequest,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(
      config.baseDir,
      "runtime",
      DESKTOP_UPDATE_RESUME_THREADS_MARKER_FILE,
    );
    return Effect.all([fs.stat(markerPath), Clock.currentTimeMillis]).pipe(
      Effect.map(([marker, now]) =>
        Option.exists(
          marker.mtime,
          (writtenAt) => now - writtenAt.getTime() < Duration.toMillis(MARKER_TTL),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );
  }),
);
