export const MOBILE_SHAPE = {
  group: { ios: 24, android: 28 },
  toast: 26,
  glass: 32,
} as const;

export const MOBILE_MOTION = {
  adjust: 120,
  enter: 200,
  exit: 150,
} as const;

const MOBILE_MIN_TOUCH_TARGET = 44;

/** Grows a smaller control's touch area to the minimum target on every side. */
export function minimumTouchSlop(size: number): number {
  return Math.max(0, (MOBILE_MIN_TOUCH_TARGET - size) / 2);
}
