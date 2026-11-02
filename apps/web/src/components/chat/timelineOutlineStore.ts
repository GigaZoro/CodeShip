import { create } from "zustand";

export interface TimelineOutlinePrompt {
  readonly id: string;
  /** As sent; the outline shortens it only when it shows it. */
  readonly text: string | null;
}

/** A timeline's prompts, for the details card outline beside it. */
export interface TimelineOutline {
  readonly prompts: ReadonlyArray<TimelineOutlinePrompt>;
  /** The prompt whose turn is on screen. */
  readonly currentId: string | null;
}

// Keyed by thread: a side chat shows a second timeline next to the main one.
const useTimelineOutlineStore = create<{
  readonly byThreadKey: Readonly<Record<string, TimelineOutline>>;
}>(() => ({ byThreadKey: {} }));

export function useTimelineOutline(threadKey: string): TimelineOutline | null {
  return useTimelineOutlineStore((state) => state.byThreadKey[threadKey] ?? null);
}

// A long pasted prompt only needs its opening words in a one-line outline row.
const OUTLINE_TEXT_LENGTH = 160;

// Bounded first, since a pasted prompt can run to thousands of characters.
export function outlinePromptText(text: string | null): string {
  return (text ?? "")
    .slice(0, OUTLINE_TEXT_LENGTH * 4)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OUTLINE_TEXT_LENGTH);
}

interface TimelinePromptItem {
  readonly id: string;
  readonly userText: string | null;
}

/**
 * Writes only on a change, and compares before it copies anything, since a timeline publishes
 * whenever its rows change, which is every event while a reply streams.
 */
export function publishTimelineOutline(
  threadKey: string,
  items: ReadonlyArray<TimelinePromptItem>,
  currentId: string | null,
): void {
  const { byThreadKey } = useTimelineOutlineStore.getState();
  const published = byThreadKey[threadKey];
  if (
    published !== undefined &&
    published.currentId === currentId &&
    published.prompts.length === items.length &&
    published.prompts.every((prompt, index) => {
      const item = items[index];
      return item !== undefined && prompt.id === item.id && prompt.text === item.userText;
    })
  ) {
    return;
  }
  const prompts = items.map((item) => ({ id: item.id, text: item.userText }));
  useTimelineOutlineStore.setState({
    byThreadKey: { ...byThreadKey, [threadKey]: { prompts, currentId } },
  });
}

const revealByThreadKey = new Map<string, (promptId: string) => void>();

/** Attaches the timeline showing a thread, which scrolls to a prompt; returns the detach. */
export function attachTimelineOutline(
  threadKey: string,
  reveal: (promptId: string) => void,
): () => void {
  revealByThreadKey.set(threadKey, reveal);
  return () => {
    if (revealByThreadKey.get(threadKey) !== reveal) return;
    revealByThreadKey.delete(threadKey);
    const { [threadKey]: _detached, ...rest } = useTimelineOutlineStore.getState().byThreadKey;
    useTimelineOutlineStore.setState({ byThreadKey: rest });
  };
}

export function revealTimelinePrompt(threadKey: string, promptId: string): void {
  revealByThreadKey.get(threadKey)?.(promptId);
}
