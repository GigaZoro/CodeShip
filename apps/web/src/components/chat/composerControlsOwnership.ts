/**
 * Where the permissions chip shows and whether it overflows. The chip is the only place to change
 * permissions: it shows at every width (label, then icon when the row compacts) and moves into the
 * overflow menu when the width measurement has no room for it. The composer.mode shortcut follows
 * whichever of the two is on screen.
 */
export function resolveComposerControlsOwnership(input: {
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  const accessDisplay = input.collapsed ? ("icon" as const) : ("label" as const);
  const overflowed = input.measuredHiddenBlockCount > 0;
  const hiddenBlockIds = overflowed ? (["mode"] as const) : ([] as const);
  return {
    accessDisplay,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
  };
}
