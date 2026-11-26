import { USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
} from "@t3tools/client-runtime/state/usage-progress";
import { isCompatibleUsageContractVersion } from "@t3tools/shared/usageMerge";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { t } from "../../lib/i18n";

export function usageEnvironmentStatus(
  environment: EnvironmentUsageStatus,
  refreshing: boolean,
  providerLabel: (provider: UsageProviderKind) => string,
  gap?: string,
): string {
  if (!environment.isConnected) return t("Waiting for connection…");
  if (
    environment.summary !== null &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  )
    return t("Update required.");
  if (gap) return gap;
  if (environment.error !== null) return environment.error;
  const progress = usageEnvironmentProgress(environment, refreshing);
  if (progress.phase === "loading") return t("Loading usage…");
  if (progress.phase === "stale") return t("Updating usage…");
  if (progress.phase === "partway")
    return updatingProvidersLabel(progress.providers, providerLabel);
  if (progress.phase === "incomplete") return t("Usage figures may be incomplete");
  return t("Usage up to date");
}
