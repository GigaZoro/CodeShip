import { create } from "zustand";

export interface ThreadSelectionState {
  selectedThreadKeys: ReadonlySet<string>;
  anchorThreadKey: string | null;
}

interface ThreadSelectionStore extends ThreadSelectionState {
  toggleThread: (threadKey: string) => void;
  /** Requires ordered scoped thread keys from the same project. */
  rangeSelectTo: (threadKey: string, orderedThreadKeys: readonly string[]) => void;
  clearSelection: () => void;
  removeFromSelection: (threadKeys: readonly string[]) => void;
  setAnchor: (threadKey: string) => void;
  shownSelection: () => readonly string[];
}

const EMPTY_SET = new Set<string>();
type ShownThreadKeys = { readonly has: (key: string) => boolean };
let shownThreadKeys: ShownThreadKeys = EMPTY_SET;

export function publishShownThreadKeys(keys: ShownThreadKeys | null): () => void {
  shownThreadKeys = keys ?? EMPTY_SET;
  return () => {
    if (shownThreadKeys === keys) shownThreadKeys = EMPTY_SET;
  };
}

export function getThreadKeysToDeselectAfterDelete(
  selectedThreadKeys: readonly string[],
  deletedThreadKeys: ReadonlySet<string>,
  hasThread: (threadKey: string) => boolean,
): string[] {
  return selectedThreadKeys.filter((key) => deletedThreadKeys.has(key) || !hasThread(key));
}

export const useThreadSelectionStore = create<ThreadSelectionStore>((set, get) => ({
  selectedThreadKeys: EMPTY_SET,
  anchorThreadKey: null,

  toggleThread: (threadKey) => {
    set((state) => {
      const next = new Set(state.selectedThreadKeys);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        next.add(threadKey);
      }
      return {
        selectedThreadKeys: next,
        anchorThreadKey: next.has(threadKey) ? threadKey : state.anchorThreadKey,
      };
    });
  },

  rangeSelectTo: (threadKey, orderedThreadKeys) => {
    set((state) => {
      const anchor = state.anchorThreadKey;
      if (anchor === null) {
        const next = new Set(state.selectedThreadKeys);
        next.add(threadKey);
        return { selectedThreadKeys: next, anchorThreadKey: threadKey };
      }

      const anchorIndex = orderedThreadKeys.indexOf(anchor);
      const targetIndex = orderedThreadKeys.indexOf(threadKey);
      if (anchorIndex === -1 || targetIndex === -1) {
        const next = new Set(state.selectedThreadKeys);
        next.add(threadKey);
        return { selectedThreadKeys: next, anchorThreadKey: threadKey };
      }

      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const next = new Set(state.selectedThreadKeys);
      for (let i = start; i <= end; i++) {
        const key = orderedThreadKeys[i];
        if (key !== undefined) {
          next.add(key);
        }
      }
      return { selectedThreadKeys: next, anchorThreadKey: anchor };
    });
  },

  clearSelection: () => {
    const state = get();
    if (state.selectedThreadKeys.size === 0 && state.anchorThreadKey === null) return;
    set({ selectedThreadKeys: EMPTY_SET, anchorThreadKey: null });
  },

  setAnchor: (threadKey) => {
    if (get().anchorThreadKey === threadKey) return;
    set({ anchorThreadKey: threadKey });
  },

  removeFromSelection: (threadKeys) => {
    set((state) => {
      const toRemove = new Set(threadKeys);
      let changed = false;
      const next = new Set<string>();
      for (const key of state.selectedThreadKeys) {
        if (toRemove.has(key)) {
          changed = true;
        } else {
          next.add(key);
        }
      }
      if (!changed) return state;
      const newAnchor =
        state.anchorThreadKey !== null && toRemove.has(state.anchorThreadKey)
          ? null
          : state.anchorThreadKey;
      return { selectedThreadKeys: next, anchorThreadKey: newAnchor };
    });
  },

  shownSelection: () => [...get().selectedThreadKeys].filter((key) => shownThreadKeys.has(key)),
}));
