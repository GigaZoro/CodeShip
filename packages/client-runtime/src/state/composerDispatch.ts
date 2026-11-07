export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** The ways a message can join a running turn, in the order menus offer them. */
export const ACTIVE_TURN_COMPOSER_ACTIONS = [
  "steer",
  "queue",
  "restart",
] as const satisfies ReadonlyArray<ActiveTurnComposerAction>;

/** Stop and send needs a provider that can stop and restart its turn; others steer instead. */
export function resolveActiveTurnDefault(input: {
  readonly preferred: ActiveTurnComposerAction;
  readonly canRestart: boolean;
}): ActiveTurnComposerAction {
  return input.preferred === "restart" && !input.canRestart ? "steer" : input.preferred;
}

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}
