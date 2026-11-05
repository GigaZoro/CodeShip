import { useState } from "react";

import { ProjectsSettings } from "../settings/ProjectsSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import type { SettingsScopeSearch } from "../settings/settingsScope";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "../ui/sheet";

import { t } from "~/i18n";
/** Project settings opened in place, so the Projects page stays behind it. */
export function ProjectSettingsSheet(props: {
  /** The settings key of the project to show, or null while closed. */
  readonly projectKey: string | null;
  readonly onClose: () => void;
}) {
  // The sheet animates out after projectKey clears, so it keeps the last scope until then.
  const [scope, setScope] = useState<SettingsScopeSearch>({});
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  if (props.projectKey !== null && props.projectKey !== openedKey) {
    setOpenedKey(props.projectKey);
    setScope({ project: props.projectKey });
  }
  return (
    <Sheet open={props.projectKey !== null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetPopup className="max-w-2xl" aria-label={t("Project settings")}>
        <SheetTitle className="sr-only">{t("Project settings")}</SheetTitle>
        <SheetDescription className="sr-only">
          {t("Name, icon, checkouts and actions for this project.")}
        </SheetDescription>
        <SettingsScopeProvider search={scope} onChange={setScope}>
          <ProjectsSettings />
        </SettingsScopeProvider>
      </SheetPopup>
    </Sheet>
  );
}
