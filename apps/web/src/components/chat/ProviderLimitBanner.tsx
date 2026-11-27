import {
  providerDriverDisplayName,
  resolveProviderInstanceDisplayName,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ProviderLimitAlternative,
  ProviderThreadLimitStandResult,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { describeLimitStand } from "@t3tools/client-runtime/usage-holds";
import { useAtomValue } from "@effect/atom-react";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ThreadNotice } from "./threadNoticeSlot.logic";
import { t } from "~/i18n";

/**
 * Where a chat stands when every account of its provider is out of usage and it will not move by
 * itself (pinned, switching off, or no other provider has room). Null when it can run or moves on
 * its own, and on servers that do not offer the answer.
 */
export function useThreadLimitStand(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): {
  readonly limited: NonNullable<ProviderThreadLimitStandResult["limited"]> | null;
  readonly refresh: () => void;
} {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const offered = serverConfig?.environment.capabilities.threadLimitStand === true;
  const stand = useEnvironmentQuery(
    offered && threadId !== null
      ? serverEnvironment.threadLimitStand({ environmentId, input: { threadId } })
      : null,
  );
  return { limited: stand.data?.limited ?? null, refresh: stand.refresh };
}

export function providerLimitBannerItem(props: {
  readonly threadId: ThreadId;
  readonly limited: NonNullable<ProviderThreadLimitStandResult["limited"]>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly timestampFormat: TimestampFormat;
  readonly onContinueOn: (alternative: ProviderLimitAlternative) => Promise<void>;
}): ThreadNotice {
  const { threadId, limited, providers, timestampFormat, onContinueOn } = props;
  const provider = providerDriverDisplayName(limited.driver);
  const label = (alternative: ProviderLimitAlternative) => {
    const account = providers.find((entry) => entry.instanceId === alternative.instanceId);
    return account ? resolveProviderInstanceDisplayName(account) : alternative.instanceId;
  };
  const { title, description } = describeLimitStand(limited, provider, (isoDate) =>
    formatUpcomingTimestamp(isoDate, timestampFormat),
  );
  return {
    id: `provider-limit-stand:${threadId}`,
    producer: "usageLimitRecovery",
    variant: "warning",
    icon: <GaugeIcon />,
    title,
    description,
    actions: (
      <>
        {limited.alternatives.map((alternative) => (
          <ContinueOnButton
            key={alternative.instanceId}
            label={label(alternative)}
            onContinue={() => onContinueOn(alternative)}
          />
        ))}
      </>
    ),
  };
}

function ContinueOnButton({
  label,
  onContinue,
}: {
  readonly label: string;
  readonly onContinue: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        setPending(true);
        onContinue()
          .catch((cause: unknown) =>
            toastManager.add({
              type: "error",
              title: t("Could not switch provider"),
              description: cause instanceof Error ? cause.message : t("An error occurred."),
              data: { source: "user-action" },
            }),
          )
          .finally(() => setPending(false));
      }}
    >
      {pending ? t("Switching...") : t("Continue on {account}", { account: label })}
    </Button>
  );
}
