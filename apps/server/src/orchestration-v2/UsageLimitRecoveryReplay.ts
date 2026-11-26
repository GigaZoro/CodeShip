import type { OrchestrationV2RunAttempt } from "@t3tools/contracts";

interface RecoveryLineage {
  readonly sourceKey: string | null;
  readonly requestKey: string | null;
  readonly selectedKey: string | null;
}

interface RecoveryReceipt extends RecoveryLineage {
  readonly attemptKey: string | null;
  readonly status: OrchestrationV2RunAttempt["status"];
}

export function replayUsageLimitRecovery(
  decision: RecoveryLineage,
  receipts: ReadonlyArray<RecoveryReceipt>,
) {
  let classification: "unknown" | "failed_attempt" | "recovered" = "unknown";
  if (decision.sourceKey && decision.requestKey && decision.selectedKey) {
    for (const receipt of receipts) {
      if (
        !receipt.attemptKey ||
        receipt.sourceKey !== decision.sourceKey ||
        receipt.requestKey !== decision.requestKey ||
        receipt.selectedKey !== decision.selectedKey
      )
        continue;
      if (receipt.status === "completed") {
        classification = "recovered";
        break;
      }
      // Cancelled, superseded and interrupted attempts were ended, not failed: they prove nothing.
      if (receipt.status === "failed") classification = "failed_attempt";
    }
  }
  return { classification, attributableLostTokens: null };
}
