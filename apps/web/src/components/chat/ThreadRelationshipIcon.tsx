import { t, msg } from "~/i18n";
import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";

import { BotIcon, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  hasInstanceBadge,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function threadRelationshipStatusLabel(
  status: string | null,
  resolve: typeof t = t,
): string {
  switch (status) {
    case "preparing":
    case "starting":
      return resolve(msg("Starting"));
    case "running":
    case "in_progress":
      return resolve(msg("Running"));
    case "pending":
    case "queued":
      return resolve(msg("Queued"));
    case "waiting":
    case "blocked":
      return resolve(msg("Waiting"));
    case "completed":
      return resolve(msg("Done"));
    case "failed":
    case "error":
      return resolve(msg("Failed"));
    case "cancelled":
    case "interrupted":
      return resolve(msg("Stopped"));
    case "rolled_back":
      return resolve(msg("Reverted"));
    case "resolved_native":
      return resolve(msg("Resolved (native)"));
    case "resolved_portable":
      return resolve(msg("Resolved (portable)"));
    case "consumed":
      return resolve(msg("Consumed"));
    case "superseded":
      return resolve(msg("Superseded"));
    case "idle":
      return resolve(msg("Idle"));
    default:
      return resolve(msg("Unknown"));
  }
}

export function ThreadRelationshipIcon({
  driver,
  provider,
  providerEntries = [],
  anyInstanceBadge = hasInstanceBadge(providerEntries),
  status,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  providerEntries?: ReadonlyArray<ProviderInstanceEntry>;
  /** For rows that can't take `providerEntries` but sit in the same list as rows that do. */
  anyInstanceBadge?: boolean;
  status: string | null;
  fallbackIcon?: LucideIcon;
}) {
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  const entry = driver
    ? providerEntries.find((candidate) => candidate.instanceId === provider?.instanceId)
    : undefined;
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, providerEntries);
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={entry?.displayName ?? provider?.displayName ?? driver}
          accentColor={entry?.accentColor}
          acpRegistryAgentId={entry?.acpRegistryAgentId}
          acpRegistryIconUrl={entry?.acpRegistryIconUrl ?? provider?.iconUrl}
          showBadge={showInstanceBadge}
          size="compact"
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          "absolute -right-1 size-2 rounded-full border-2 border-card",
          anyInstanceBadge ? "-top-1" : "-bottom-1",
          status === "running" ||
            status === "in_progress" ||
            status === "pending" ||
            status === "waiting"
            ? "bg-info"
            : status === "failed" || status === "error"
              ? "bg-destructive"
              : status === "completed"
                ? "bg-success"
                : "bg-muted-foreground/45",
        )}
        aria-hidden="true"
      />
    </span>
  );
}
