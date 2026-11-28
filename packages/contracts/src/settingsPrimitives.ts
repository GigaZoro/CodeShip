import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KeybindingShortcut } from "./keybindings.ts";

/**
 * Leaf schemas shared between `settings.ts` and domain contracts (`usage.ts`, `scheduledTask.ts`,
 * `pullRequest.ts`, `preview.ts`, `ipc.ts`, `serverUpdate.ts`) so editing an isolated domain contract does not
 * invalidate every consumer of `settings.ts` or `ipc.ts`.
 */

/**
 * Matches a usage record by model id and optional provider slug (case-insensitive on the server).
 */
export const UsageModelSelector = Schema.Struct({
  provider: Schema.optional(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString,
});
export type UsageModelSelector = typeof UsageModelSelector.Type;

/** Keeps records matching `include` (all when omitted) and not matching `exclude`. */
export const UsageModelFilter = Schema.Struct({
  include: Schema.optional(Schema.Array(UsageModelSelector)),
  exclude: Schema.optional(Schema.Array(UsageModelSelector)),
});
export type UsageModelFilter = typeof UsageModelFilter.Type;

export const ScheduledTaskPlacement = Schema.Literals(["none", "chat", "pinned"]);
export type ScheduledTaskPlacement = typeof ScheduledTaskPlacement.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const SnapShotKeyChord = KeybindingShortcut.check(
  Schema.makeFilter(
    (shortcut) =>
      shortcut.metaKey ||
      shortcut.ctrlKey ||
      shortcut.shiftKey ||
      shortcut.altKey ||
      shortcut.modKey ||
      "Snapshot shortcut requires a modifier.",
  ),
);
export type SnapShotKeyChord = typeof SnapShotKeyChord.Type;

export const SNAP_SHOT_MODIFIERS = ["shift", "meta", "control", "alt"] as const;
export const SnapShotModifier = Schema.Literals(SNAP_SHOT_MODIFIERS);
export type SnapShotModifier = typeof SnapShotModifier.Type;

export const SnapShotShortcut = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("both-shift-keys") }),
  Schema.Struct({ kind: Schema.Literal("modifier-pair"), modifier: SnapShotModifier }),
  SnapShotKeyChord,
]);
export type SnapShotShortcut = typeof SnapShotShortcut.Type;

export type SnapShotModifierPairShortcut = Extract<SnapShotShortcut, { readonly kind: string }>;

export function isModifierPairShortcut(
  shortcut: SnapShotShortcut,
): shortcut is SnapShotModifierPairShortcut {
  return "kind" in shortcut;
}

export function snapShotShortcutModifierPair(
  shortcut: SnapShotModifierPairShortcut,
): SnapShotModifier {
  return shortcut.kind === "both-shift-keys" ? "shift" : shortcut.modifier;
}

const APPLE_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Command",
  control: "Control",
  alt: "Option",
};
const OTHER_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Super",
  control: "Ctrl",
  alt: "Alt",
};

export function snapShotModifierPairLabel(modifier: SnapShotModifier, apple: boolean): string {
  const label = (apple ? APPLE_MODIFIER_LABELS : OTHER_MODIFIER_LABELS)[modifier];
  return `${label} + ${label}`;
}

export const PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
export const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
export const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;

const PreviewViewportDimension = Schema.Int.check(
  Schema.isBetween({
    minimum: PREVIEW_VIEWPORT_MIN_DIMENSION,
    maximum: PREVIEW_VIEWPORT_MAX_DIMENSION,
  }),
);

const viewportAreaFilter = Schema.makeFilter(
  ({ width, height }: { readonly width: number; readonly height: number }) =>
    width * height <= PREVIEW_VIEWPORT_MAX_AREA ||
    `Viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`,
);

export const PreviewViewportSize = Schema.Struct({
  width: PreviewViewportDimension,
  height: PreviewViewportDimension,
}).check(viewportAreaFilter);
export type PreviewViewportSize = typeof PreviewViewportSize.Type;

export const PREVIEW_VIEWPORT_PRESET_IDS = [
  "iphone-se",
  "iphone-xr",
  "iphone-12-pro",
  "iphone-14-pro-max",
  "pixel-7",
  "samsung-galaxy-s8-plus",
  "samsung-galaxy-s20-ultra",
  "ipad-mini",
  "ipad-air",
  "ipad-pro",
  "surface-pro-7",
  "surface-duo",
  "galaxy-z-fold-5",
  "asus-zenbook-fold",
  "samsung-galaxy-a51-71",
  "nest-hub",
  "nest-hub-max",
] as const;

export const PreviewViewportPresetId = Schema.Literals(PREVIEW_VIEWPORT_PRESET_IDS);
export type PreviewViewportPresetId = typeof PreviewViewportPresetId.Type;

const LEGACY_PREVIEW_VIEWPORT_PRESET_IDS = [
  "desktop-1920x1080",
  "desktop-1440x900",
  "laptop-1366x768",
  "laptop-1280x800",
  "ipad-pro-11",
  "iphone-15-pro",
  "pixel-8",
  "galaxy-s24",
] as const;

const StoredPreviewViewportPresetId = Schema.Literals([
  ...PREVIEW_VIEWPORT_PRESET_IDS,
  ...LEGACY_PREVIEW_VIEWPORT_PRESET_IDS,
]);

export const PreviewViewportSetting = Schema.Union([
  Schema.TaggedStruct("fill", {}),
  Schema.TaggedStruct("freeform", {
    ...PreviewViewportSize.fields,
  }).check(viewportAreaFilter),
  Schema.TaggedStruct("preset", {
    ...PreviewViewportSize.fields,
    presetId: StoredPreviewViewportPresetId,
  }).check(viewportAreaFilter),
]);
export type PreviewViewportSetting = typeof PreviewViewportSetting.Type;

export const FILL_PREVIEW_VIEWPORT = {
  _tag: "fill",
} as const satisfies PreviewViewportSetting;

/** Shared steps keep settings aligned with desktop Chromium zoom controls. */
export const PREVIEW_ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
] as const;

export const PreviewZoomFactor = Schema.Literals(PREVIEW_ZOOM_LEVELS);
export type PreviewZoomFactor = typeof PreviewZoomFactor.Type;

export const DEFAULT_PREVIEW_ZOOM_FACTOR: PreviewZoomFactor = 1.0;

export const PreviewAppearancePreference = Schema.Literals(["system", "light", "dark"]);
export type PreviewAppearancePreference = typeof PreviewAppearancePreference.Type;

export const DEFAULT_PREVIEW_APPEARANCE: PreviewAppearancePreference = "system";

export const BROWSER_RECORDING_FRAME_RATES = [30, 60] as const;
export const BrowserRecordingFrameRate = Schema.Literals(BROWSER_RECORDING_FRAME_RATES);
export type BrowserRecordingFrameRate = typeof BrowserRecordingFrameRate.Type;
export const DEFAULT_BROWSER_RECORDING_FRAME_RATE: BrowserRecordingFrameRate = 30;

export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);
export type DesktopUpdateChannel = typeof DesktopUpdateChannelSchema.Type;
