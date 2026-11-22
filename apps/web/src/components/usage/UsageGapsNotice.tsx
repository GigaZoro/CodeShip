import type { usageNotices } from "@t3tools/client-runtime/state/usage-view";
import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { UsageRetryButton } from "./UsageRetryButton";

export function UsageGapsNotice({
  notice,
  retrying,
  onRetry,
}: {
  readonly notice: ReturnType<typeof usageNotices>["coverage"];
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
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
          <UsageRetryButton pending={retrying} onRetry={onRetry} />
        </AlertAction>
      ) : null}
    </Alert>
  );
}
