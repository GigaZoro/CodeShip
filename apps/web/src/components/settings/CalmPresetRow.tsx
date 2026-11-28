import { CheckIcon, Undo2Icon } from "lucide-react";
import { useRef } from "react";

import { t } from "~/i18n";
import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  applyCalmPreset,
  formatCalmPresetChange,
  planCalmPreset,
  selectCalmPresetSettings,
  undoCalmPreset,
  useLastAppliedCalmPreset,
} from "./calmPreset";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CalmPresetRow() {
  const settings = useClientSettings(selectCalmPresetSettings);
  const plan = planCalmPreset(settings);
  const lastApplied = useLastAppliedCalmPreset();
  const pendingFocusRef = useRef<"apply" | "undo" | null>(null);

  const handleApply = () => {
    const applied = applyCalmPreset();
    if (applied !== null) {
      pendingFocusRef.current = "undo";
    }
  };

  const handleUndo = () => {
    if (undoCalmPreset()) {
      pendingFocusRef.current = "apply";
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("calm-preset")}
      description={t(
        "Applies compact spacing, Essentials thread details, folding older finished turns, and calm status colors. Notifications stay unchanged.",
      )}
      control={
        <div className="flex flex-wrap items-center gap-2">
          {plan.isActive ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CheckIcon aria-hidden className="size-3.5" />
              {t("Active")}
            </span>
          ) : (
            <Button
              ref={(element) => {
                if (element && pendingFocusRef.current === "apply") {
                  pendingFocusRef.current = null;
                  element.focus();
                }
              }}
              size="sm"
              variant="outline"
              onClick={handleApply}
            >
              {t("Apply Calm")}
            </Button>
          )}
          {lastApplied !== null ? (
            <Button
              ref={(element) => {
                if (element && pendingFocusRef.current === "undo") {
                  pendingFocusRef.current = null;
                  element.focus();
                }
              }}
              size="sm"
              variant="ghost"
              onClick={handleUndo}
            >
              <Undo2Icon aria-hidden className="size-3.5" />
              {t("Undo")}
            </Button>
          ) : null}
        </div>
      }
    >
      {lastApplied !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 mb-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          <p className="font-medium text-foreground">{t("Changed by Calm preset")}</p>
          <ul className="mt-1 space-y-0.5">
            {lastApplied.changes.map((change) => (
              <li key={change.key}>{formatCalmPresetChange(change)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </SettingsRow>
  );
}
