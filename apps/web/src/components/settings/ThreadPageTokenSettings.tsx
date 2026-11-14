import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useManualSteps } from "../../state/manualSteps";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Label } from "../ui/label";
import { SecretInput } from "./SecretInput";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { t, tx } from "~/i18n";

const CONNECTIONS_URL = "https://thread.page/app/settings/connections";

function ThreadPageTokenForm(props: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string | null;
}) {
  const saved = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.threadPage.apiToken.length > 0,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: t("save the ThreadPage token"),
  });
  const refreshManualSteps = useManualSteps().refresh;
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (apiToken: string) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId: props.environmentId,
      input: { patch: { threadPage: { apiToken } } },
    });
    setSaving(false);
    if (result._tag !== "Success") return;
    setDraft("");
    // The list answered for the old token; ask again so it fills or clears now.
    refreshManualSteps();
  };
  const inputId = `threadpage-token-${props.environmentId}`;
  return (
    <form
      className="grid gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) void save(draft.trim());
      }}
    >
      {/* Locked while saving: a successful save clears the draft, which would drop edits made mid-request. */}
      <fieldset disabled={saving} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          {tx(
            "{manualSteps} lists the steps only you can do, which agents keep in ThreadPage's Machine inbox folder. Scheduled-task checks on this machine can also list threads, add notes and change a thread's description or status through it. This server keeps the token and never shows it to apps or checks. In ThreadPage, open Settings, Connections, then Connect an automation, Script or API: choose Read only, Can add notes when a check adds notes, or Can edit and organize when it changes threads, and Work or All threads.",
            {
              manualSteps: (
                <InlineButton render={<Link to="/manual-steps" />}>
                  {t("Manual steps")}
                </InlineButton>
              ),
            },
          )}{" "}
          <InlineButton
            render={<a href={CONNECTIONS_URL} target="_blank" rel="noreferrer noopener" />}
          >
            {t("Open ThreadPage connections")}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>
            {props.machineLabel === null
              ? t("ThreadPage token")
              : t("ThreadPage token on {machine}", { machine: props.machineLabel })}
          </Label>
          <SecretInput
            id={inputId}
            size="sm"
            configured={saved}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {saved ? t("A token is saved.") : t("No token saved.")}
          </p>
          <div className="flex shrink-0 gap-2">
            {saved ? (
              <Button size="xs" variant="outline" onClick={() => void save("")}>
                {t("Remove")}
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={!draft.trim()}>
              {t("Save")}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}

/** The token one machine reads ThreadPage with; any one machine with it fills Manual steps. */
export function ThreadPageTokenSettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  if (environment?.connection.phase !== "connected") return null;
  if (environment.serverConfig?.environment.capabilities.manualSteps !== true) return null;
  return (
    <SettingsSection id={searchableSetting("threadpage-token").id} title={t("ThreadPage")}>
      <ThreadPageTokenForm
        key={environment.environmentId}
        environmentId={environment.environmentId}
        machineLabel={connectedEnvironments.length > 1 ? environment.label : null}
      />
    </SettingsSection>
  );
}
