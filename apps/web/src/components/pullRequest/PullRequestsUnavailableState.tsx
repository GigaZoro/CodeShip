import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon, SettingsIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { PullRequestGlyph } from "./pullRequestIcons";
import { SourceControlMessage } from "./PullRequestListGapsNotice";

export function PullRequestsUnavailableState({
  title = "Could not load pull requests",
  error,
  onRetry,
  refreshing = false,
  host,
  onOpenSettings,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
  host?: { readonly url: string; readonly openLabel: string };
  /** Most list failures are a missing CLI or credential, which Source control settings fixes. */
  onOpenSettings?: () => void;
}) {
  return (
    <Empty className="scrollbar-gutter-both min-h-0 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <PullRequestGlyph.pullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          <SourceControlMessage text={error} />
        </EmptyDescription>
      </EmptyHeader>
      {onRetry || host || onOpenSettings ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
              Retry
            </Button>
          ) : null}
          {host ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={host.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              {host.openLabel}
            </Button>
          ) : null}
          {onOpenSettings ? (
            <Button size="sm" variant="outline" onClick={onOpenSettings}>
              <SettingsIcon aria-hidden className="size-3.5" />
              Source control settings
            </Button>
          ) : null}
        </div>
      ) : null}
    </Empty>
  );
}
