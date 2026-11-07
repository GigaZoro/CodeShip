import { useSyncExternalStore } from "react";
import { isEditableFocused } from "./lib/editableFocus";

export interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

function createShortcutModifierStore(ignoreEditable: boolean) {
  let state = EMPTY_SHORTCUT_MODIFIER_STATE;
  const listeners = new Set<() => void>();
  const update = (next: ShortcutModifierState) => {
    if (areShortcutModifierStatesEqual(state, next)) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const onKeyboardEvent = (event: KeyboardEvent) => {
    update(
      ignoreEditable && isEditableFocused(event.target)
        ? EMPTY_SHORTCUT_MODIFIER_STATE
        : shortcutModifierStateAfterKeyboardEvent(state, event),
    );
  };
  // Dictation tools can omit Meta keyup after synthetic paste, leaving jump hints stuck.
  const onResetEvent = () => update(EMPTY_SHORTCUT_MODIFIER_STATE);
  const onFocus = (event: FocusEvent) => {
    if (ignoreEditable && isEditableFocused(event.target)) onResetEvent();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        window.addEventListener("focusin", onFocus);
        window.addEventListener("keydown", onKeyboardEvent, true);
        window.addEventListener("keyup", onKeyboardEvent, true);
        window.addEventListener("paste", onResetEvent, true);
        window.addEventListener("blur", onResetEvent);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        window.removeEventListener("focusin", onFocus);
        window.removeEventListener("keydown", onKeyboardEvent, true);
        window.removeEventListener("keyup", onKeyboardEvent, true);
        window.removeEventListener("paste", onResetEvent, true);
        window.removeEventListener("blur", onResetEvent);
        // Keys pressed while nobody listens go unseen, so the next subscriber starts clean.
        state = EMPTY_SHORTCUT_MODIFIER_STATE;
      };
    },
  };
}

const shortcutModifierStore = createShortcutModifierStore(false);
const outsideEditableShortcutModifierStore = createShortcutModifierStore(true);

/**
 * Re-renders only when `select` returns a different value, so a large component that needs one
 * flag does not re-render on every Shift press while the user types. `select` must return a
 * primitive or a stable reference.
 */
export function useShortcutModifierSelection<T>(
  select: (state: ShortcutModifierState) => T,
  ignoreEditable = false,
): T {
  const store = ignoreEditable ? outsideEditableShortcutModifierStore : shortcutModifierStore;
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}

export function useShortcutModifierState(ignoreEditable = false): ShortcutModifierState {
  return useShortcutModifierSelection((state) => state, ignoreEditable);
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  let nextState: ShortcutModifierState;
  if (normalizedModifierKey) {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    };
  } else {
    // Dictation paste can poison real events with metaKey=true until a physical Meta press.
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    };
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
