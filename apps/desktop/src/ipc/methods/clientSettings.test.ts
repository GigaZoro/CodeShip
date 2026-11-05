import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { getLanguageSettings } from "./clientSettings.ts";

const layerElectronApp = Layer.mock(ElectronApp.ElectronApp, {
  preferredSystemLanguages: Effect.succeed(["uk-UA", "en-US"]),
});

describe("language settings IPC", () => {
  it.effect("reports the saved language with the system languages", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* getLanguageSettings.handler(undefined), {
        preference: "uk",
        systemLanguages: ["uk-UA", "en-US"],
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerElectronApp,
          Layer.mock(DesktopClientSettings.DesktopClientSettings, {
            get: Effect.promise(async () =>
              Option.some({ ...DEFAULT_CLIENT_SETTINGS, language: "uk" }),
            ),
          }),
        ),
      ),
    ),
  );

  it.effect("follows the system when no settings are saved", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* getLanguageSettings.handler(undefined), {
        preference: "system",
        systemLanguages: ["uk-UA", "en-US"],
      });
    }).pipe(Effect.provide(Layer.mergeAll(layerElectronApp, DesktopClientSettings.layerTest()))),
  );

  it.effect("follows the system when the settings cannot be read", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* getLanguageSettings.handler(undefined), {
        preference: "system",
        systemLanguages: ["uk-UA", "en-US"],
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerElectronApp,
          Layer.mock(DesktopClientSettings.DesktopClientSettings, {
            get: Effect.fail(
              new DesktopClientSettings.DesktopClientSettingsReadError({
                operation: "read-file",
                path: "/settings.json",
                cause: new Error("denied"),
              }),
            ),
          }),
        ),
      ),
    ),
  );
});
