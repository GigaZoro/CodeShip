import { getFormattingLocale, t, tn } from "~/i18n";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useOpenLink } from "~/browser/useOpenLink";

import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
  threadRef,
}: PullRequestReplyAvailability & { threadRef: ScopedThreadRef | null }) {
  const openLink = useOpenLink(threadRef);
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0
          ? tn(moreReplies, "{formatted} more reply", "{formatted} more replies", {
              formatted: moreReplies.toLocaleString(getFormattingLocale()),
            })
          : t("More replies")}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
          onClick={(event) => {
            event.preventDefault();
            void openLink(url, { event }).catch(console.error);
          }}
        >
          {t("View on host")}
        </a>
      ) : null}
    </div>
  );
}
