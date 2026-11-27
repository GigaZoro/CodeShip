import { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon, LayersIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { Button } from "../ui/button";
import { AgentConversationsSettings } from "./AgentConversationsSettings";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer } from "./settingsLayout";
import { NewProjectsSettingsSection } from "./SettingsPanels";
import {
  ALL_ENVIRONMENTS_VALUE,
  selectEnvironmentAxis,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";
import { t } from "~/i18n";

export function ProjectsSettings() {
  const { search: value, scope, selectScope } = useSettingsScope();
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              {t("Show all environments")}
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <SettingsPageContainer>
          <NewProjectsSettingsSection />
          <ProjectChooser />
          <AgentConversationsSettings />
        </SettingsPageContainer>
      )}
    </div>
  );
}

function ProjectChooser() {
  const { groups, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  if (groups.length === 0) return null;
  return (
    <div className="space-y-3">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        {t("Choose a project to manage its name, icon, checkouts and actions.")}
      </p>
      <SettingsGroup>
        {groups.map((group) => {
          const secondary = [
            ...(group.archived ? [t("Archived")] : []),
            ...(groups.some(
              (other) =>
                other.projectKey !== group.projectKey && other.displayName === group.displayName,
            )
              ? settingsScopeProjectMachines(group, environments)
              : []),
            group.workspaceRoot,
          ].join(" · ");
          return (
            <button
              key={group.projectKey}
              type="button"
              className={cn(
                ITEM_ROW_CLASSNAME,
                "flex w-full min-w-0 cursor-pointer items-center gap-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
              onClick={() => selectScope({ project: group.projectKey })}
            >
              <ProjectFavicon project={group} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{group.displayName}</span>
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate text-xs text-muted-foreground" />}
                  >
                    {secondary}
                  </TooltipTrigger>
                  <TooltipPopup>{secondary}</TooltipPopup>
                </Tooltip>
              </span>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
      </SettingsGroup>
    </div>
  );
}
