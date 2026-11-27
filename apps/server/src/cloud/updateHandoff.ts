import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

const DESKTOP_UPDATE_RESTART_MARKER_TTL = Duration.minutes(1);

const desktopMarkerPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE);
});

const isFreshMarker = (mtime: Option.Option<Date>, now: number): boolean =>
  Option.match(mtime, {
    onNone: () => false,
    onSome: (writtenAt) =>
      now - writtenAt.getTime() < Duration.toMillis(DESKTOP_UPDATE_RESTART_MARKER_TTL),
  });

export const pendingServiceUpdateExists = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const stateText = yield* fs
    .readFileString(path.join(runtimeDir, SERVICE_STATE_FILE))
    .pipe(Effect.option);
  return Option.isSome(stateText) && serviceStateHasPendingUpdate(stateText.value);
});

const pendingUpdateHandoffExists = Effect.gen(function* () {
  if (!(yield* pendingServiceUpdateExists)) {
    return false;
  }
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const stopping = yield* fs
    .exists(path.join(runtimeDir, SERVICE_STOP_MARKER_FILE))
    .pipe(Effect.orElseSucceed(() => false));
  return !stopping;
});

// Reading consumes the marker, so a stale one cannot turn the next shutdown into an update.
const consumeDesktopUpdateRestartMarker = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const markerPath = yield* desktopMarkerPath;
  const marker = yield* fs.stat(markerPath).pipe(Effect.option);
  if (Option.isNone(marker)) {
    return false;
  }
  yield* fs.remove(markerPath);
  const now = yield* Clock.currentTimeMillis;
  return isFreshMarker(marker.value.mtime, now);
});

const decidePlannedUpdateShutdown = Effect.gen(function* () {
  // Consume the desktop marker even when a service handoff already answers the question.
  const desktopRestart = yield* consumeDesktopUpdateRestartMarker;
  const serviceHandoff = yield* pendingUpdateHandoffExists;
  return desktopRestart || serviceHandoff;
});

/**
 * Whether the current shutdown is a planned update. Several shutdown finalizers ask (CloudLink
 * keeps its tunnel, ServerRuntimeStartup detaches provider hosts) and reading the desktop
 * marker consumes it, so the first answer is kept and every later caller gets the same one.
 */
export class UpdateShutdownState extends Context.Service<
  UpdateShutdownState,
  {
    readonly isPlannedUpdateShutdown: Effect.Effect<boolean>;
  }
>()("t3/cloud/updateHandoff/UpdateShutdownState") {}

export const makeUpdateShutdownState = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isPlannedUpdateShutdown = yield* Effect.cached(
    decidePlannedUpdateShutdown.pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      // An unreadable marker or state file cannot prove an update, so the shutdown is ordinary.
      Effect.catchCause((cause) =>
        Effect.logError("Could not decide whether this shutdown is a planned update", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    ),
  );
  return UpdateShutdownState.of({ isPlannedUpdateShutdown });
});

export const layerUpdateShutdownState = Layer.effect(UpdateShutdownState, makeUpdateShutdownState);
