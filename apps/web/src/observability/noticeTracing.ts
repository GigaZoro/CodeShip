import * as Effect from "effect/Effect";

import { noticeLog, type NoticeEvent } from "../components/ui/toastNoticeLog";
import { runtime } from "../lib/runtime";

/** Attributes only: titles can name threads and projects, so they stay in the page. */
function spanOf(event: NoticeEvent) {
  const { record } = event;
  const attributes = {
    "notice.source": record.source,
    "notice.type": record.type,
    "notice.delivery": record.delivery,
    "notice.count": record.count,
  };
  return event.kind === "shown"
    ? {
        name: "web.notice.shown",
        attributes: { ...attributes, "notice.coalesced": event.coalesced },
      }
    : { name: "web.notice.ended", attributes: { ...attributes, "notice.outcome": record.outcome } };
}

/**
 * Sends one span per notice shown or ended to the primary server's trace file, so emitter
 * counts over days can be read there after the in-memory log has rolled over.
 */
export function startNoticeTracing(): () => void {
  return noticeLog.subscribeEvents((event) => {
    const { name, attributes } = spanOf(event);
    runtime.runFork(Effect.void.pipe(Effect.withSpan(name, { attributes })));
  });
}
