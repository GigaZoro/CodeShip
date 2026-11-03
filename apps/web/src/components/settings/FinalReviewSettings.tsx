import type {
  EnvironmentId,
  ModelSelection,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsModelSelectionControl } from "./DelegatedTaskModelSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function FinalReviewSettings({
  environmentId,
  settings,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const instructionsEdited = useRef(false);
  const reviewers = settings.finalReviewModelSelections;
  const setReviewers = (next: ReadonlyArray<ModelSelection>) =>
    updateSettings({ finalReviewModelSelections: next });
  const firstReady = providerInstanceEntriesFor(providers, settings, null).find(
    isProviderInstancePickerReady,
  );

  return (
    <SettingsSection {...searchableSetting("final-review")}>
      <SettingsRow
        title="Review new threads"
        description="After a request you send changes files, each reviewer checks those changes as a read-only task, and the thread's agent fixes what it confirms. Reviews use turns on the reviewers' accounts. Turn it on or off for one thread from its menu."
        control={
          <Switch
            aria-label="Review new threads"
            checked={settings.finalReviewByDefault}
            disabled={readOnly}
            onCheckedChange={(checked) => updateSettings({ finalReviewByDefault: checked })}
          />
        }
      />
      <SettingsRow
        title="Reviewers"
        description={
          reviewers.length === 0
            ? "Add at least one reviewer. Reviewers on different providers catch different issues."
            : "Each reviews the same changes on its own."
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || firstReady === undefined}
            onClick={() => {
              if (firstReady === undefined) return;
              setReviewers([
                ...reviewers,
                createModelSelection(firstReady.instanceId, firstReady.models[0]?.slug ?? ""),
              ]);
            }}
          >
            <PlusIcon />
            Add reviewer
          </Button>
        }
      />
      {reviewers.map((reviewer, index) => (
        <SettingsRow
          // Reviewers have no id of their own, and the same model may be listed twice.
          // oxlint-disable-next-line react/no-array-index-key -- a reviewer is its position in the list
          key={index}
          title={`Reviewer ${index + 1}`}
          control={
            <div className="flex min-w-0 items-center justify-end gap-1.5">
              <SettingsModelSelectionControl
                environmentId={environmentId}
                settings={settings}
                providers={providers}
                readOnly={readOnly}
                label={`Reviewer ${index + 1} model`}
                selection={reviewer}
                onChange={(next) =>
                  setReviewers(reviewers.map((current, at) => (at === index ? next : current)))
                }
              />
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={`Remove reviewer ${index + 1}`}
                disabled={readOnly}
                onClick={() => setReviewers(reviewers.filter((_, at) => at !== index))}
              >
                <Trash2Icon />
              </Button>
            </div>
          }
        />
      ))}
      <SettingsRow
        title="Review instructions"
        description="Added to every reviewer's brief, such as project rules, checklists, or the checks to run."
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={settings.finalReviewInstructions}
            aria-label="Review instructions"
            rows={4}
            disabled={readOnly}
            defaultValue={settings.finalReviewInstructions}
            placeholder="Check tenant and permission boundaries. Run the focused tests for changed services."
            onChange={() => {
              instructionsEdited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (instructionsEdited.current && value !== settings.finalReviewInstructions)
                updateSettings({ finalReviewInstructions: value });
              instructionsEdited.current = false;
            }}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
