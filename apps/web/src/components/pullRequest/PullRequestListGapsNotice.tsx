import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { TriangleAlertIcon, XIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { t, tx } from "~/i18n";

/** A host or project the list could not read, so its pull requests are missing. */
export interface PullRequestListGap {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
}

/** Source control errors quote commands in backticks; show those as code, not literal ticks. */
export function SourceControlMessage({ text }: { readonly text: string }) {
  let offset = 0;
  return text.split("`").map((part, index) => {
    const at = offset;
    offset += part.length + 1;
    return index % 2 === 1 ? (
      <code key={at} className="font-mono">
        {part}
      </code>
    ) : (
      part
    );
  });
}

export function useOpenSourceControlSettings() {
  const navigate = useNavigate();
  return () => void navigate({ to: "/settings/source-control" });
}

/**
 * Names what the list left out while other hosts answered. Dismissing hides this exact set,
 * so a host that is unconfigured on purpose stays quiet until something else fails.
 */
export function PullRequestListGapsNotice({
  gaps,
}: {
  readonly gaps: readonly PullRequestListGap[];
}) {
  const openSettings = useOpenSourceControlSettings();
  const signature = gaps
    .map((gap) => `${gap.key}\u0000${gap.detail}`)
    .toSorted()
    .join("\n");
  const [dismissed, setDismissed] = useLocalStorage(
    "t3code:pull-requests:dismissed-gaps",
    "",
    Schema.String,
  );
  if (gaps.length === 0 || dismissed === signature) return null;
  const [only] = gaps;
  return (
    <Alert variant="warning" role="status" controlAlignment="first-line">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>
        {gaps.length === 1 && only
          ? t("Pull requests from {label} are missing", { label: only.label })
          : t("Pull requests from {count} sources are missing", { count: gaps.length })}
      </AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {gaps.map((gap) => (
            <li key={gap.key} className="break-words">
              {gaps.length > 1 ? (
                tx("{label}: {detail}", {
                  label: gap.label,
                  detail: <SourceControlMessage text={gap.detail} />,
                })
              ) : (
                <SourceControlMessage text={gap.detail} />
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={openSettings}>
          {t("Settings")}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("Dismiss")}
          onClick={() => setDismissed(signature)}
        >
          <XIcon aria-hidden />
        </Button>
      </AlertAction>
    </Alert>
  );
}
