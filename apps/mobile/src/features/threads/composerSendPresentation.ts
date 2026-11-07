import {
  ACTIVE_TURN_COMPOSER_ACTIONS,
  alternateComposerDispatchAction,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";

import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import { msg, t, type Message } from "../../lib/i18n";

export interface ComposerSendPresentation {
  readonly label: string;
  readonly icon:
    | "arrow.up"
    | "tray.and.arrow.up"
    | "checkmark"
    | "list.number"
    | "arrow.turn.left.up"
    | "arrow.clockwise";
  readonly action: ActiveTurnComposerAction | null;
  readonly alternate: ActiveTurnComposerAction | null;
  /** What the long-press menu offers, in order. */
  readonly choices: ReadonlyArray<ActiveTurnComposerAction>;
  readonly offersFollowUpChoice: boolean;
}

const ACTION_LABEL: Record<ActiveTurnComposerAction, Message> = {
  queue: msg("Queue"),
  steer: msg("Steer"),
  restart: msg("Stop and send"),
};

const ACTION_ICON = {
  queue: "list.number",
  steer: "arrow.turn.left.up",
  restart: "arrow.clockwise",
} as const satisfies Record<ActiveTurnComposerAction, ComposerSendPresentation["icon"]>;

export function resolveComposerSendPresentation(input: {
  readonly editingQueuedMessage: boolean;
  readonly running: boolean;
  readonly canSteer: boolean;
  /** The running turn can be stopped and restarted with this message. */
  readonly canRestart: boolean;
  readonly followUpBehavior: FollowUpBehavior;
  readonly deliveryDeferred: boolean;
}): ComposerSendPresentation {
  if (input.editingQueuedMessage) {
    return {
      label: t("Update queued message"),
      icon: "checkmark",
      action: null,
      alternate: null,
      choices: [],
      offersFollowUpChoice: false,
    };
  }
  if (!input.running) {
    return {
      label: input.deliveryDeferred ? t("Queue") : t("Send"),
      icon: input.deliveryDeferred ? "tray.and.arrow.up" : "arrow.up",
      action: null,
      alternate: null,
      choices: [],
      offersFollowUpChoice: false,
    };
  }
  const action: ActiveTurnComposerAction = input.canSteer ? input.followUpBehavior : "queue";
  const alternate = alternateComposerDispatchAction(action);
  return {
    label: t(ACTION_LABEL[action]),
    icon: ACTION_ICON[action],
    action,
    alternate: input.canSteer ? alternate : null,
    choices: input.canSteer
      ? ACTIVE_TURN_COMPOSER_ACTIONS.filter((choice) => choice !== "restart" || input.canRestart)
      : [],
    offersFollowUpChoice: input.canSteer,
  };
}
