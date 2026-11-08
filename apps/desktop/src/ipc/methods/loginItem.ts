import { DesktopLoginItemStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLoginItem from "../../app/DesktopLoginItem.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getLoginItemState = makeIpcMethod({
  channel: IpcChannels.LOGIN_ITEM_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopLoginItemStateSchema,
  handler: Effect.fn("desktop.ipc.loginItem.getState")(function* () {
    return yield* (yield* DesktopLoginItem.DesktopLoginItem).state;
  }),
});

export const setLoginItemEnabled = makeIpcMethod({
  channel: IpcChannels.LOGIN_ITEM_SET_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopLoginItemStateSchema,
  handler: Effect.fn("desktop.ipc.loginItem.setEnabled")(function* (enabled) {
    return yield* (yield* DesktopLoginItem.DesktopLoginItem).setEnabled(enabled);
  }),
});
