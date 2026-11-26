import { t } from "~/i18n";
import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PROXY_NAME = "CLI Proxy";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState<"cliproxy" | "http" | null>(null);
  const entries = Object.entries(sources);
  // Without a hub or a way to add one, the section has nothing to show.
  if (entries.length === 0 && readOnly) return null;

  const addActions = (
    <div className="flex gap-2">
      <Button size="xs" variant="outline" onClick={() => setAdding("cliproxy")}>
        <PlusIcon className="size-3" aria-hidden />
        {t("Add hub")}
      </Button>
      <Button size="xs" variant="outline" onClick={() => setAdding("http")}>
        <PlusIcon className="size-3" aria-hidden />
        {t("Add HTTP source")}
      </Button>
    </div>
  );

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          // An empty list carries its own add buttons, beside the words that say it is empty.
          !readOnly && entries.length > 0 ? addActions : null
        }
      >
        {entries.length === 0 ? (
          readOnly ? null : (
            <SettingsRow
              title={t("No usage sources configured.")}
              description={t("A source adds usage limits to the Limits view.")}
              control={addActions}
            />
          )
        ) : (
          entries.map(([id, source]) => {
            const kindLabel = source.kind === "http" ? t("HTTP quota source") : CLI_PROXY_NAME;
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {source.enabled ? kindLabel : t("{name} · Disabled", { name: kindLabel })}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          kind={adding}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {t("Remove")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remove {label}?", { label })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("The saved connection and its credentials are removed from this environment.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {t("Remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
