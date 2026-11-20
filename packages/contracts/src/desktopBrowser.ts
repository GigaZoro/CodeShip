import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /** No window can show the awaited tab, so the server runs it headless. */
  Schema.Struct({ type: Schema.Literal("declined"), ...TabKey }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

/**
 * How long the server waits for a desktop tab to attach. The desktop keeps its window rendering
 * meanwhile, and a renderer still loading after a restart needs the margin. The desktop also ends
 * its hold after this long, so an `awaiting: false` lost with its pipe cannot keep the hold.
 */
export const DESKTOP_BROWSER_ATTACH_WAIT_MS = 60_000;

export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  /** Whether an agent turn runs on the thread, so the tabs it uses stay focused between steps. */
  Schema.Struct({
    type: Schema.Literal("turn"),
    threadId: TrimmedNonEmptyString,
    active: Schema.Boolean,
  }),
  /** Whether the server waits for this tab to attach, so the desktop keeps its window rendering. */
  Schema.Struct({ type: Schema.Literal("awaiting"), ...TabKey, active: Schema.Boolean }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
