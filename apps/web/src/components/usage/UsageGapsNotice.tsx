import { formatUsageContractMismatch } from "@t3tools/shared/usageFormat";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { CircleAlertIcon } from "lucide-react";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

/**
 * Environments whose usage is missing or old, so a failed scan never reads as zero spend.
 * A failed rescan keeps the environment's last summary, which the totals still count.
 */
function usageGaps(
  environments: readonly EnvironmentUsageStatus[],
  contractMismatches: MergedUsage["contractMismatches"],
) {
  const mismatchById = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  return environments.flatMap((environment) => {
    if (environment.error !== null) {
      const stale = environment.summary !== null;
      return [
        {
          environment,
          message: `${environment.label}: ${environment.error}${stale ? " Showing its last values." : ""}`,
          excluded: !stale,
          // Only a scan can be retried; a closed connection or missing access cannot.
          retryable: environment.canReadDiagnostics,
        },
      ];
    }
    const mismatch = mismatchById.get(environment.environmentId);
    return mismatch === undefined
      ? []
      : [
          {
            environment,
            message: formatUsageContractMismatch(environment.label, mismatch),
            excluded: true,
            retryable: false,
          },
        ];
  });
}

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
  const gaps = usageGaps(environments, contractMismatches);
  if (gaps.length === 0) return null;
  const excluded = gaps.filter((gap) => gap.excluded);
  const [onlyExcluded] = excluded;
  return (
    <Alert variant="warning" role="status" controlAlignment="first-line">
      <CircleAlertIcon aria-hidden />
      <AlertTitle>
        {onlyExcluded === undefined
          ? "Some totals may be out of date"
          : excluded.length === 1
            ? `Totals leave out ${onlyExcluded.environment.label}`
            : `Totals leave out ${excluded.length} environments`}
      </AlertTitle>
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
            Retry
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
