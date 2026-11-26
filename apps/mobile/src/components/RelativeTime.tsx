import { t } from "../lib/i18n";

import { useSyncExternalStore } from "react";
import { msUntilRelativeTimeChange, relativeTime } from "../lib/time";

// The React Compiler caches inline relativeTime calls on the timestamp alone.
export function RelativeTime(props: { timestamp: string }) {
  const messages = t;
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delayMs = msUntilRelativeTimeChange(props.timestamp);
      if (delayMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const getSnapshot = () => relativeTime(props.timestamp, Date.now(), messages);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
