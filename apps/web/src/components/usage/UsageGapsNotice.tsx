import { usageGaps } from "@t3tools/client-runtime/state/usage-progress";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { CircleAlertIcon } from "lucide-react";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { t } from "~/i18n";

export function UsageGapsNotice({
  environments,
  contractMismatches,
  retrying,
  onRetry,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const notice = usageGaps(environments, contractMismatches);
  if (notice === null) return null;
  const { title, gaps } = notice;
  return (
    <Alert variant="warning" role="status" controlAlignment="first-line">
      <CircleAlertIcon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {gaps.map((gap) => (
            <li key={gap.environment.environmentId} className="break-words">
              {gap.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
      {gaps.some((gap) => gap.retryable) ? (
        <AlertAction>
          <Button size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
            {t("Retry")}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
