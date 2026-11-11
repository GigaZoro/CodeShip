import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { t } from "~/i18n";
import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { machineSettingDifferences } from "./machineSettingDifferences.logic";
import { planScopedSettingsPatch } from "./scopedSettings";
import { EveryMachineSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useRunScopedSettingsPlan, useSharedScopeNotice } from "./useScopedSettings";

/** Settings people keep the same everywhere, listed where machines disagree. */
export function MachineSettingDifferencesSection() {
  return (
    <EveryMachineSettingsScope>
      <MachineSettingDifferences />
    </EveryMachineSettingsScope>
  );
}

function MachineSettingDifferences() {
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const runPlan = useRunScopedSettingsPlan();
  const sharedNotice = useSharedScopeNotice();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  const differences = machineSettingDifferences(
    connectedEnvironments.flatMap((environment) =>
      environment.serverConfig
        ? [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              settings: environment.serverConfig.settings,
            },
          ]
        : [],
    ),
  );
  const unreachable = environments.filter(
    (environment) =>
      !connectedEnvironments.some(
        (connected) => connected.environmentId === environment.environmentId,
      ),
  );
  const readOnly = connectedEnvironments.filter(
    (environment) => !writable.has(environment.environmentId),
  );
  const writeBlockedReason =
    readOnly.length > 0
      ? t("This connection lacks permission to change settings on {environment}.", {
          environment: readOnly.map((environment) => environment.label).join(", "),
        })
      : null;

  return (
    <SettingsSection {...searchableSetting("machine-setting-differences")}>
      {connectedEnvironments.length < 2 ? (
        <SettingsRow
          title={t("Connect another machine to compare")}
          description={t("Settings are compared across the machines that are connected now.")}
        />
      ) : differences.length === 0 ? (
        <SettingsRow
          title={t("Every machine has the same settings")}
          description={t(
            "Settings that belong to one machine, such as paths and accounts, are not compared.",
          )}
        />
      ) : (
        differences.map((difference) => (
          <SettingsRow
            key={difference.id}
            title={difference.title}
            control={
              <Button
                size="xs"
                variant="ghost"
                render={<Link to={difference.page} hash={difference.anchor} />}
              >
                {t("Open")}
              </Button>
            }
          >
            <ul role="list" className="divide-y divide-border/60 pb-2">
              {difference.values.map((value) => {
                const label = t("Use {machine}'s value everywhere", { machine: value.label });
                const button = (
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={label}
                    disabled={writeBlockedReason !== null}
                    // The chosen machine's value becomes the shared version, attributed to that machine.
                    onClick={() =>
                      runPlan(
                        planScopedSettingsPatch(
                          scope,
                          environments,
                          value.patch,
                          value.environmentId,
                        ),
                      )
                    }
                  >
                    {t("Use everywhere")}
                  </Button>
                );
                return (
                  <li
                    key={value.environmentId}
                    className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-sm"
                  >
                    <span className="truncate text-muted-foreground">{value.label}</span>
                    <span className="line-clamp-2 break-words text-foreground tabular-nums">
                      {value.display}
                    </span>
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        {button}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{writeBlockedReason ?? label}</TooltipPopup>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </SettingsRow>
        ))
      )}
      {sharedNotice && differences.length > 0 ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">{sharedNotice}</p>
      ) : null}
      {unreachable.length > 0 ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {t("Reconnect {machines} to compare their settings.", {
            machines: unreachable.map((environment) => environment.label).join(", "),
          })}
        </p>
      ) : null}
    </SettingsSection>
  );
}
