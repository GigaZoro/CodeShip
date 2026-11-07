import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { tn } from "@t3tools/shared/i18n";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_NOTIFICATION_BADGE_CHANNEL, WINDOW_FOCUS_CHANNEL } from "../channels.ts";

const NotificationBadge = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 })),
  image: Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(16_384),
      Schema.isPattern(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i),
    ),
  ),
});

function applyNotificationBadge(
  platform: NodeJS.Platform,
  { count, image }: typeof NotificationBadge.Type,
): void {
  try {
    if (platform === "win32") {
      const overlay = count > 0 && image ? Electron.nativeImage.createFromDataURL(image) : null;
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.setOverlayIcon(
            overlay?.isEmpty() ? null : overlay,
            count > 0 ? tn(count, "{count} thread needs you", "{count} threads need you") : "",
          );
        }
      }
    } else if (platform === "darwin" || platform === "linux") {
      Electron.app.setBadgeCount(count);
    }
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not update notification badge", error));
  }
}

export const installNotificationBadge = Effect.fn("desktop.ipc.installNotificationBadge")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const platform = yield* HostProcess.Platform;
    // The badge counts threads that need the user, so it stays while a window is focused.
    const clear = () => applyNotificationBadge(platform, { count: 0, image: null });
    const announceFocus = () => {
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(WINDOW_FOCUS_CHANNEL);
      }
    };
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_NOTIFICATION_BADGE_CHANNEL,
        payload: NotificationBadge,
        result: Schema.Void,
        handler: (badge) => Effect.sync(() => applyNotificationBadge(platform, badge)),
      }),
    );
    yield* app.on("browser-window-focus", announceFocus);
    yield* app.on("before-quit", clear);
    yield* Effect.addFinalizer(() => Effect.sync(clear));
  },
);
