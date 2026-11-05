import { ClientSettingsSchema } from "@t3tools/contracts";
import { normalizeLanguagePreference } from "@t3tools/shared/i18n";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopLanguage from "../../settings/DesktopLanguage.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
    // The menu is built once at startup, so a new language needs a rebuild to show.
    const preference = normalizeLanguagePreference(settings.language);
    if (yield* DesktopLanguage.activateLanguagePreference(preference)) {
      yield* (yield* DesktopApplicationMenu.DesktopApplicationMenu).configure;
    }
  }),
});

export const getLanguageSettings = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_LANGUAGE_SETTINGS_CHANNEL,
  result: Schema.Struct({
    preference: Schema.String,
    systemLanguages: Schema.Array(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.clientSettings.getLanguageSettings")(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    return {
      preference: yield* DesktopLanguage.readLanguagePreference(),
      systemLanguages: yield* electronApp.preferredSystemLanguages,
    };
  }),
});
