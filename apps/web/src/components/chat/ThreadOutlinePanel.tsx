import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  outlinePromptText,
  revealTimelinePrompt,
  useTimelineOutline,
} from "./timelineOutlineStore";

// One prompt is the whole thread, so there is nothing to move between.
const OUTLINE_MIN_PROMPTS = 2;

/** The prompts sent in this thread, one line each; selecting one scrolls the timeline to it. */
export function ThreadOutlinePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadKey = scopedThreadKey(scopeThreadRef(props.environmentId, props.threadId));
  const outline = useTimelineOutline(threadKey);
  const listRef = useRef<HTMLOListElement | null>(null);
  const currentId = outline?.currentId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the on-screen prompt visible inside the outline's own scroll area as the timeline scrolls
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || currentId === null) return;
    const row = list.querySelector<HTMLElement>(`[data-outline-prompt="${CSS.escape(currentId)}"]`);
    if (row === null) return;
    // Scrolls only the list, never the card or the page around it.
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [currentId]);
  if (outline === null || outline.prompts.length < OUTLINE_MIN_PROMPTS) return null;
  return (
    <ThreadDetailsSection
      data-thread-details-flexible
      headingId="thread-details-outline-heading"
      title="Your prompts"
    >
      {/* Scrolls on its own, so a long thread keeps the sections above it in view. */}
      <ol
        ref={listRef}
        className="relative m-0 flex max-h-72 list-none flex-col overflow-y-auto p-0"
      >
        {outline.prompts.map((prompt) => {
          const current = prompt.id === currentId;
          const text = outlinePromptText(prompt.text);
          return (
            <li key={prompt.id} data-outline-prompt={prompt.id}>
              <Tooltip>
                <TooltipTrigger
                  delay={500}
                  render={
                    <ThreadDetailsControl
                      size="sm"
                      variant="ghost"
                      part="row"
                      aria-current={current ? "location" : undefined}
                      onClick={() => revealTimelinePrompt(threadKey, prompt.id)}
                    />
                  }
                >
                  {/* Older history may not be loaded, so prompts are marked, not numbered. */}
                  <span
                    aria-hidden
                    className={cn(
                      "h-3.5 w-0.5 shrink-0 rounded-full",
                      current ? "bg-primary" : "bg-muted-foreground/25",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-left",
                      current ? "text-foreground" : "font-normal text-foreground/70",
                    )}
                  >
                    {text.length > 0 ? text : "Attachment"}
                  </span>
                </TooltipTrigger>
                {/* The row shows a few words; this shows the rest of the prompt's opening. */}
                {text.length > 0 ? (
                  <TooltipPopup side="left" className="max-w-80 whitespace-normal">
                    {text}
                  </TooltipPopup>
                ) : null}
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </ThreadDetailsSection>
  );
}
