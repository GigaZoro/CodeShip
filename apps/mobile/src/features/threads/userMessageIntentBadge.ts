import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";
import { t } from "../../lib/i18n";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
  unread = false,
): UserMessageIntentBadgePresentation | null {
  if (unread && (intent === "steer" || intent === "promoted_queued_to_steer")) {
    return {
      label: t("Steer · waiting to be read"),
      accessibilityLabel: t(
        "Steer waiting for the agent to read it after the running command finishes",
      ),
    };
  }
  switch (intent) {
    case "steer":
      return {
        label: t("Steer"),
        accessibilityLabel: t("Steered the active turn"),
      };
    case "promoted_queued_to_steer":
      return {
        label: t("Steer"),
        accessibilityLabel: t("Originally queued, then promoted to steer the active turn"),
      };
    case "queued_turn":
    case "turn_start":
    case undefined:
      return null;
  }
}
