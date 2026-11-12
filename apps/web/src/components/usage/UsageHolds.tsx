import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PauseCircleIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { RetryAccountButton } from "../chat/RetryAccountButton";
import { InlineButton } from "../ui/button";
import { describeUsageHold, heldAccountsForDriver } from "@t3tools/client-runtime/usage-holds";
import { t } from "~/i18n";

/** The accounts of one driver that CodeShip skips after a usage refusal, on one machine. */
function EnvironmentHolds({
  environmentId,
  environmentLabel,
  showEnvironment,
  driver,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly showEnvironment: boolean;
  readonly driver: ServerProvider["driver"];
  readonly now: number;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const holdsOffered = serverConfig?.environment.capabilities.usageHolds === true;
  const holds = useEnvironmentQuery(
    holdsOffered ? serverEnvironment.usageHolds({ environmentId, input: {} }) : null,
  );
  const retryUsageLimit = useAtomCommand(serverEnvironment.retryUsageLimit, {
    reportFailure: false,
  });
  const canRetry = useAtomValue(serverEnvironment.retryUsageLimit.permissionAtom(environmentId));
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const held = heldAccountsForDriver(
    serverConfig?.providers ?? [],
    holds.data?.holds ?? [],
    driver,
  );
  if (held.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {held.map(({ provider, hold }) => (
        <li
          key={hold.instanceId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
        >
          <PauseCircleIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium text-foreground">
              {showEnvironment
                ? `${environmentLabel}: ${resolveProviderInstanceDisplayName(provider)}`
                : resolveProviderInstanceDisplayName(provider)}
            </span>{" "}
            {describeUsageHold(hold, (isoDate) =>
              formatUpcomingTimestamp(isoDate, timestampFormat, now),
            )}
          </span>
          {canRetry ? (
            <RetryAccountButton
              variant="outline"
              onRetry={async () => {
                const result = await retryUsageLimit({
                  environmentId,
                  input: { instanceId: hold.instanceId },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              }}
            />
          ) : null}
          {hold.appCap ? (
            <InlineButton
              render={
                <Link
                  to="/settings/providers"
                  search={{ environmentId, instanceId: hold.instanceId }}
                />
              }
            >
              {t("Switch sign-in")}
            </InlineButton>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ProviderHolds({
  driver,
  environments,
  now,
}: {
  readonly driver: ServerProvider["driver"];
  readonly environments: ReadonlyMap<EnvironmentId, string>;
  readonly now: number;
}) {
  return [...environments].map(([environmentId, label]) => (
    <EnvironmentHolds
      key={environmentId}
      environmentId={environmentId}
      environmentLabel={label}
      showEnvironment={environments.size > 1}
      driver={driver}
      now={now}
    />
  ));
}
