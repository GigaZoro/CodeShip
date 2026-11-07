import { t } from "@t3tools/shared/i18n";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    /** Applies the saved setting; run once Electron is ready. */
    readonly initialize: Effect.Effect<void>;
    /** Shows or removes the tray icon. While it shows, closing the main window only hides it. */
    readonly configure: (closeWindowToTray: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-tray");

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let tray: Electron.Tray | null = null;

  const destroyTray = () => {
    tray?.destroy();
    tray = null;
  };
  const open = () => {
    void runPromise(
      desktopWindow.activate.pipe(
        Effect.catchCause((cause) =>
          logWarning("failed to open the window from the tray", { cause }),
        ),
      ),
    );
  };
  const quit = () => {
    void runPromise(electronApp.quit);
  };

  // Quit can outrun layer finalizers, and Windows shows a dead process's icon until it is hovered.
  yield* electronApp.on("will-quit", destroyTray);
  yield* Effect.addFinalizer(() => Effect.sync(destroyTray));

  const configure = Effect.fn("desktop.tray.configure")(function* (closeWindowToTray: boolean) {
    // macOS keeps the app in the Dock, and many Linux desktops (stock GNOME) show no tray icons.
    const wanted =
      environment.platform === "win32" && closeWindowToTray && !(yield* Ref.get(state.quitting));
    const icon = wanted ? (yield* assets.iconPaths).ico : Option.none<string>();
    if (Option.isNone(icon)) {
      if (wanted) yield* logWarning("no tray icon available; closing the window quits");
      yield* Ref.set(state.closeToTray, false);
      yield* Effect.sync(destroyTray);
      return;
    }
    const isNew = tray === null;
    const shown = yield* Effect.try(() => {
      if (tray === null) {
        tray = new Electron.Tray(icon.value);
        tray.setToolTip(environment.displayName);
        tray.on("click", open);
      }
      // Rebuilt on every call so a language change reaches the menu.
      tray.setContextMenu(
        Electron.Menu.buildFromTemplate([
          { label: t("Open {name}", { name: environment.displayName }), click: open },
          { type: "separator" },
          { label: t("Quit {name}", { name: environment.displayName }), click: quit },
        ]),
      );
    }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        logWarning("failed to show the tray icon; closing the window quits", { cause }).pipe(
          Effect.andThen(Effect.sync(destroyTray)),
          Effect.as(false),
        ),
      ),
    );
    if (shown && isNew) yield* logInfo("tray icon shown");
    yield* Ref.set(state.closeToTray, shown);
  });

  return DesktopTray.of({
    initialize: clientSettings.get.pipe(
      Effect.map(
        Option.match({
          onNone: () => DEFAULT_CLIENT_SETTINGS.closeWindowToTray,
          onSome: (settings) => settings.closeWindowToTray,
        }),
      ),
      Effect.orElseSucceed(() => DEFAULT_CLIENT_SETTINGS.closeWindowToTray),
      Effect.flatMap(configure),
      Effect.withSpan("desktop.tray.initialize"),
    ),
    configure,
  });
});

export const layer = Layer.effect(DesktopTray, make);
