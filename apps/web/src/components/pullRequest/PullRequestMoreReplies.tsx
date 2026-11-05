import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";
import { t, tn } from "~/i18n";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0
          ? tn(moreReplies, "{count} more reply", "{count} more replies")
          : t("More replies")}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
        >
          {t("View on host")}
        </a>
      ) : null}
    </div>
  );
}
