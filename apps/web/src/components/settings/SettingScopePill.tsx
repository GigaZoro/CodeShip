import { t } from "~/i18n";
import { ChevronDownIcon, FolderIcon, LayersIcon, MonitorIcon } from "lucide-react";

import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { useOptionalSettingsScope, type SettingScopeUnit } from "./SettingsScopeContext";
import { EnvironmentScopeMenu, ProjectScopeMenu } from "./SettingsScopeSentence";
import { useSharedScopeNotice } from "./useScopedSettings";

/** The inline scope chip for the row or section whose id is the scope's anchor. */
export function SettingScopePill({ anchorId }: { anchorId: string | undefined }) {
  const context = useOptionalSettingsScope();
  const unit = context?.unit;
  // Every row asks; only the anchor subscribes to the environment list.
  if (!context || !unit || anchorId !== unit.anchorId) return null;
  return <SettingScopePopover context={context} unit={unit} />;
}

function SettingScopePopover({
  context,
  unit,
}: {
  context: NonNullable<ReturnType<typeof useOptionalSettingsScope>>;
  unit: SettingScopeUnit;
}) {
  const { environments } = useEnvironments();
  const sharedNotice = useSharedScopeNotice();
  const choosesProject = unit.axes === "project" && context.groups.length > 0;
  if (!choosesProject && environments.length <= 1) return null;
  const menuProps = {
    value: context.search,
    groups: context.groups,
    environments,
    singleEnvironment: context.singleEnvironment,
    onChange: context.selectScope,
  };
  const Icon =
    context.scope.kind === "project" || context.scope.kind === "checkout"
      ? FolderIcon
      : context.scope.kind === "all"
        ? LayersIcon
        : MonitorIcon;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" size="micro" />}
        className="min-w-0 max-w-48"
        aria-label={t("Scope of {setting}: {scope}", {
          setting: unit.title,
          scope: context.scope.label,
        })}
      >
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{context.scope.label}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-70" />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <div className="flex flex-col gap-3">
          <PopoverTitle>{t("Where {setting} applies", { setting: unit.title })}</PopoverTitle>
          {choosesProject ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">{t("Project")}</span>
              <ProjectScopeMenu {...menuProps} />
            </div>
          ) : null}
          {environments.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">{t("Environment")}</span>
              <EnvironmentScopeMenu {...menuProps} />
            </div>
          ) : null}
          {sharedNotice ? <p className="text-xs text-muted-foreground">{sharedNotice}</p> : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
