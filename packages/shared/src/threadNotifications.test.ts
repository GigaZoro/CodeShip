import { describe, expect, it } from "@effect/vitest";
import { ThreadNotificationLevel } from "@t3tools/contracts/threadPreferences";
import { NotificationMode } from "@t3tools/contracts/settings";
import { shouldNotifyThread } from "./threadNotifications.ts";

describe("thread notification policy", () => {
  it.each(
    NotificationMode.literals.flatMap((mode) =>
      ThreadNotificationLevel.literals.flatMap((level) =>
        (["completion", "input", "other"] as const).map((kind) => ({ mode, level, kind })),
      ),
    ),
  )("applies $level in $mode mode to $kind", ({ mode, level, kind }) => {
    const globalEnabled = mode !== "off";
    const expected = {
      default: globalEnabled,
      muted: false,
      following: kind === "other" ? globalEnabled : true,
    };
    expect(shouldNotifyThread(globalEnabled, level, kind)).toBe(expected[level]);
    expect(shouldNotifyThread(globalEnabled, undefined, kind)).toBe(expected.default);
  });
});
