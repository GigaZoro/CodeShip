import { t } from "~/i18n";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { InfoIcon } from "lucide-react";
import { Button } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RefreshIcon } from "../ui/refresh-icon";
import { deriveProviderStatus } from "../settings/providerStatus";
import type { ThreadNotice } from "./threadNoticeSlot.logic";

function getIncompatibleVersion(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory;
  const { key } = deriveProviderStatus(provider);
  if (key === "error" && provider.auth.status === "unauthenticated") return null;
  return compatibility?.status === "broken" ||
    (key === "ready" && compatibility?.status === "unsupported")
    ? compatibility
    : null;
}

/** Names the problem the thread notice reports, so a dismissal holds until it changes. */
export function getProviderStatusNoticeKey(provider: ServerProvider | null): string | null {
  if (!provider) return null;
  const { key } = deriveProviderStatus(provider);
  if (key === "disabled") return null;
  const incompatible = getIncompatibleVersion(provider);
  if (incompatible) {
    return [
      provider.instanceId,
      incompatible.status,
      provider.version ?? "",
      incompatible.message ?? "",
    ].join("\u0000");
  }
  if (key !== "error" && key !== "warning") return null;
  return [provider.instanceId, key, provider.auth.status, provider.message ?? ""].join("\u0000");
}

export function shouldShowProviderStatusNotice(
  provider: ServerProvider | null,
  dismissedNoticeKey: string | null,
): boolean {
  const noticeKey = getProviderStatusNoticeKey(provider);
  return noticeKey !== null && noticeKey !== dismissedNoticeKey;
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

export function getProviderStatusMessage(status: ServerProvider): string {
  if (
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message
  ) {
    return status.compatibilityAdvisory.message;
  }
  if (status.message) return status.message;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return t("Open provider setup to install {provider} on this environment.", {
      provider: formatProviderDriverKindLabel(status.driver),
    });
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? t("Open provider setup to sign in with Google.")
        : t("Open provider setup to sign in.");
    }
    return t("Sign in via the CLI to authenticate again.");
  }
  const { key } = deriveProviderStatus(status);
  return key === "ready"
    ? t("No models are available for this provider.")
    : key === "error"
      ? t("{provider} provider is unavailable.", { provider: providerName })
      : t("{provider} provider has limited availability.", { provider: providerName });
}

/** The active provider's problem, as one producer of the thread's notice slot. */
export function providerStatusNotice({
  environmentId,
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  environmentId: EnvironmentId;
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider;
}): ThreadNotice {
  const derived = deriveProviderStatus(status);
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = derived.key === "error" && status.auth.status === "unauthenticated";
  const incompatible = getIncompatibleVersion(status);
  const driverLabel = formatProviderDriverKindLabel(status.driver);
  const accountedName =
    providerName === driverLabel ? driverLabel : `${driverLabel} (${providerName})`;
  const title = isUnauthenticated
    ? t("{provider} is signed out", { provider: accountedName })
    : incompatible
      ? incompatible.status === "broken"
        ? t("{provider} {version} is known to be broken", {
            provider: providerName,
            version: status.version ?? "",
          })
        : t("{provider} {version} is unsupported", {
            provider: providerName,
            version: status.version ?? "",
          })
      : t("{provider} provider status", { provider: providerName });
  const isWarning = incompatible ? incompatible.status !== "broken" : derived.key === "warning";
  return {
    id: `provider-status:${status.instanceId}`,
    producer: "providerStatus",
    // A provider that cannot answer is why a reply beside an open question would fail.
    group: "environment",
    variant: isWarning ? "warning" : "error",
    icon: <InfoIcon />,
    title,
    description: incompatible?.message ?? getProviderStatusMessage(status),
    actions: (
      <>
        {onOpenProviderSetup && hasProviderSetup(status) ? (
          <Button size="xs" variant="ghost" onClick={() => onOpenProviderSetup(status.instanceId)}>
            {t("Open provider setup")}
          </Button>
        ) : null}
        <ProviderStatusRefreshButton
          environmentId={environmentId}
          instanceId={status.instanceId}
          providerName={providerName}
        />
      </>
    ),
    dismissLabel: t("Dismiss {provider} provider {status}", {
      provider: providerName,
      status: status.status,
    }),
    onDismiss,
  };
}

function ProviderStatusRefreshButton({
  environmentId,
  instanceId,
  providerName,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  providerName: string;
}) {
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "Refresh provider status",
  });
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = async () => {
    if (!canRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    await refreshProviders({ environmentId, input: { instanceId, refreshModels: true } });
    refreshingRef.current = false;
    setIsRefreshing(false);
  };

  return (
    <Button
      aria-label={t("Refresh {provider} provider status", { provider: providerName })}
      disabled={!canRefresh || isRefreshing}
      onClick={() => void refresh()}
      size="xs"
      variant="ghost"
    >
      <RefreshIcon />
      {isRefreshing ? t("Refreshing...") : t("Refresh")}
    </Button>
  );
}
