import { CommandId, ThreadColor, ThreadNotificationLevel, type ThreadId } from "@t3tools/contracts";
import { msg, t } from "@t3tools/shared/i18n";
import type { EnvironmentThreadShell } from "./state/models.ts";

const colorLabels = {
  red: msg("Red"),
  orange: msg("Orange"),
  yellow: msg("Yellow"),
  green: msg("Green"),
  blue: msg("Blue"),
  purple: msg("Purple"),
  gray: msg("Gray"),
} satisfies Record<ThreadColor, string>;

const levelLabels = {
  default: msg("Default"),
  muted: msg("Mute"),
  following: msg("Follow"),
} satisfies Record<ThreadNotificationLevel, string>;

type Preferences = Pick<EnvironmentThreadShell, "notificationLevel" | "color">;
type Capabilities = { readonly threadNotificationLevel?: boolean; readonly threadColor?: boolean };
type Action = `notifications:${ThreadNotificationLevel}` | `color:${ThreadColor | "none"}`;

export function threadPreferenceMenuItems(
  thread: Preferences,
  capabilities: Capabilities | undefined,
) {
  return [
    ...(capabilities?.threadNotificationLevel === true
      ? [
          {
            id: "notifications" as const,
            label: t("Notifications"),
            children: ThreadNotificationLevel.literals.map((level) => ({
              id: `notifications:${level}` as const,
              label: t(levelLabels[level]),
              checked: level === (thread.notificationLevel ?? "default"),
            })),
          },
        ]
      : []),
    ...(capabilities?.threadColor === true
      ? [
          {
            id: "color" as const,
            label: t("Color"),
            children: [
              { id: "color:none" as const, label: t("None"), checked: thread.color == null },
              ...ThreadColor.literals.map((color) => ({
                id: `color:${color}` as const,
                label: t(colorLabels[color]),
                checked: thread.color === color,
              })),
            ],
          },
        ]
      : []),
  ];
}
export type ThreadPreferenceMenuId = "notifications" | "color" | Action;

export function threadPreferenceCommand(action: string, threadId: ThreadId, newId: () => string) {
  const notificationLevel = ThreadNotificationLevel.literals.find(
    (level) => action === `notifications:${level}`,
  );
  if (notificationLevel !== undefined) {
    return {
      type: "thread.notification-level.set" as const,
      commandId: CommandId.make(newId()),
      threadId,
      notificationLevel,
    };
  }
  const color = ThreadColor.literals.find((value) => action === `color:${value}`);
  if (color !== undefined || action === "color:none") {
    return {
      type: "thread.color.set" as const,
      commandId: CommandId.make(newId()),
      threadId,
      color: color ?? null,
    };
  }
  return null;
}

export function threadPreferenceLabels(thread: Preferences) {
  return {
    color:
      thread.color == null
        ? null
        : t("Thread color: {color}", { color: t(colorLabels[thread.color]) }),
    notifications:
      thread.notificationLevel === "muted"
        ? t("Thread notifications muted")
        : thread.notificationLevel === "following"
          ? t("Following thread")
          : null,
  };
}
