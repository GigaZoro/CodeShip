import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

const DESKTOP_UPDATE_RESTART_MARKER_TTL = Duration.minutes(1);

// CloudLink's finalizer consumes the desktop restart marker before ServerRuntimeStartup runs;
// remember fresh markers in-process so shutdown hooks still recognize planned desktop updates.
const consumedFreshDesktopMarkers = new Map<string, number>();

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

export const pendingUpdateHandoffExists = Effect.gen(function* () {
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

// Reading consumes it, so shutdown checks it first.
export const desktopUpdateRestartPending = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const markerPath = yield* desktopMarkerPath;
  const marker = yield* fs.stat(markerPath).pipe(Effect.option);
  if (Option.isNone(marker)) {
    return false;
  }
  yield* fs.remove(markerPath).pipe(Effect.ignore);
  const now = yield* Clock.currentTimeMillis;
  const fresh = isFreshMarker(marker.value.mtime, now);
  if (fresh) {
    consumedFreshDesktopMarkers.set(markerPath, now);
  }
  return fresh;
});

export const isPlannedUpdateShutdown = Effect.gen(function* () {
  if (yield* pendingUpdateHandoffExists) {
    return true;
  }
  const markerPath = yield* desktopMarkerPath;
  const now = yield* Clock.currentTimeMillis;
  const consumedAt = consumedFreshDesktopMarkers.get(markerPath);
  if (
    consumedAt !== undefined &&
    now - consumedAt < Duration.toMillis(DESKTOP_UPDATE_RESTART_MARKER_TTL)
  ) {
    return true;
  }
  const fs = yield* FileSystem.FileSystem;
  const marker = yield* fs.stat(markerPath).pipe(Effect.option);
  return Option.isSome(marker) && isFreshMarker(marker.value.mtime, now);
});
