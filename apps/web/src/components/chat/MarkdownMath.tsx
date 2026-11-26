import { t } from "~/i18n";
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "../../lib/observeResize";

/** Makes a Words equation keyboard-scrollable only when its viewport overflows. */
export const MarkdownMath = memo(function MarkdownMath(props: {
  children: ReactNode;
  copyMarkdown: string;
  display: boolean;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes formula DOM width to make overflowing equations keyboard scrollable
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => setOverflows(viewport.scrollWidth > viewport.clientWidth);
    measure();
    // Typesetting and streamed TeX can change content width without resizing the viewport.
    return observeResize([viewport, content], measure);
  }, []);
  return (
    <span
      data-math-display={props.display || undefined}
      className={
        props.display
          ? "my-[0.65rem] block in-[.chat-markdown-table-container]:max-w-none in-[.chat-markdown-table-container]:overflow-visible"
          : "inline-block max-w-full align-middle whitespace-nowrap wrap-normal break-normal in-[.chat-markdown-table-container]:max-w-none in-[.chat-markdown-table-container]:overflow-visible"
      }
      data-markdown-math={props.display ? "display" : "inline"}
      data-markdown-copy={props.copyMarkdown}
      role="group"
      aria-label={props.display ? t("Display equation") : t("Inline equation")}
    >
      <span
        ref={viewportRef}
        className="block max-w-full overflow-x-auto overflow-y-hidden in-[.chat-markdown-table-container]:max-w-none in-[.chat-markdown-table-container]:overflow-visible px-0.5 py-0.75 focus-visible:outline-1 focus-visible:outline-solid focus-visible:-outline-offset-1 focus-visible:outline-border [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:border [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-clip-content"
        tabIndex={overflows ? 0 : -1}
        aria-label={
          !overflows
            ? undefined
            : props.display
              ? t("Scroll display equation")
              : t("Scroll inline equation")
        }
      >
        <span
          ref={contentRef}
          className={props.display ? "inline-block w-max min-w-full" : "inline-block w-max"}
        >
          {props.children}
        </span>
      </span>
    </span>
  );
});
