// @effect-diagnostics nodeBuiltinImport:off -- Writes the desktop restart marker the way the desktop app does.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { makeUpdateShutdownState } from "./updateHandoff.ts";

const withBaseDir = (
  body: (paths: {
    readonly markerPath: string;
  }) => Effect.Effect<void, never, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-update-handoff-test-"));
  const runtimeDir = NodePath.join(dir, "runtime");
  NodeFS.mkdirSync(runtimeDir, { recursive: true });
  const markerPath = NodePath.join(runtimeDir, DESKTOP_UPDATE_RESTART_MARKER_FILE);
  return body({ markerPath }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    Effect.provide(ServerConfig.layerTest(dir, dir).pipe(Layer.provideMerge(NodeServices.layer))),
  );
};

describe("UpdateShutdownState", () => {
  // Live clock: freshness compares the marker file's real mtime with the current time.
  it.live("keeps the planned-update answer after the first caller consumed the marker", () =>
    withBaseDir(({ markerPath }) =>
      Effect.gen(function* () {
        NodeFS.writeFileSync(markerPath, "1\n");
        const cloudLinkView = yield* makeUpdateShutdownState;

        assert.isTrue(yield* cloudLinkView.isPlannedUpdateShutdown);
        assert.isFalse(NodeFS.existsSync(markerPath));
        // ServerRuntimeStartup's finalizer runs after CloudLink's and must see the same decision.
        assert.isTrue(yield* cloudLinkView.isPlannedUpdateShutdown);
      }),
    ),
  );

  it.live("treats a stale desktop marker as an ordinary shutdown and removes it", () =>
    withBaseDir(({ markerPath }) =>
      Effect.gen(function* () {
        NodeFS.writeFileSync(markerPath, "1\n");
        const twoMinutesAgoSeconds = (yield* Clock.currentTimeMillis) / 1_000 - 120;
        NodeFS.utimesSync(markerPath, twoMinutesAgoSeconds, twoMinutesAgoSeconds);
        const state = yield* makeUpdateShutdownState;

        assert.isFalse(yield* state.isPlannedUpdateShutdown);
        assert.isFalse(NodeFS.existsSync(markerPath));
      }),
    ),
  );

  it.live("reports an ordinary shutdown when no marker or handoff exists", () =>
    withBaseDir(() =>
      Effect.gen(function* () {
        const state = yield* makeUpdateShutdownState;
        assert.isFalse(yield* state.isPlannedUpdateShutdown);
      }),
    ),
  );
});
