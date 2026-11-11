import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as Settings from "../serverSettings.ts";
import { readDesktopAutoInstallReadiness } from "./desktopAutoInstallReadiness.ts";

const read = (options: {
  readonly enabled: boolean;
  readonly runningTurns?: boolean;
  readonly work?: boolean;
}) =>
  readDesktopAutoInstallReadiness.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            installUpdatesAutomatically: options.enabled,
          }),
        }),
        Layer.mock(ProviderRuntimeRecoveryService)({
          restartHold: Effect.succeed({
            work: options.work
              ? [
                  {
                    threadId: ThreadId.make("thread-1"),
                    threadTitle: "Coordinator",
                    kind: "subagent",
                    label: "Review",
                    id: "w1",
                  },
                ]
              : [],
            runningTurns: options.runningTurns
              ? [{ threadId: ThreadId.make("thread-2"), threadTitle: "Answering" }]
              : [],
          }),
        }),
      ),
    ),
  );

describe("desktop automatic install readiness", () => {
  it.effect.each([
    { name: "nothing running", options: { enabled: true }, idle: true },
    { name: "a chat answering", options: { enabled: true, runningTurns: true }, idle: false },
    { name: "background work", options: { enabled: true, work: true }, idle: false },
  ])("reports idle=$idle with $name", ({ options, idle }) =>
    Effect.gen(function* () {
      expect(yield* read(options)).toEqual({ enabled: true, idle });
    }),
  );

  it.effect("reports the setting being off", () =>
    Effect.gen(function* () {
      expect(yield* read({ enabled: false })).toEqual({ enabled: false, idle: true });
    }),
  );
});
