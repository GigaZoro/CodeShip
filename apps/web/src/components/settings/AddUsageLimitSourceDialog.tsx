import type { EnvironmentId, SecretReference, UnifiedSettings } from "@t3tools/contracts";
import { useId, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { sourceIdFromUrl } from "./AddUsageLimitSourceDialog.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { Label } from "../ui/label";
import { t } from "~/i18n";

/** Send the management key once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  sources,
  kind = "cliproxy",
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly kind?: "cliproxy" | "http";
  readonly sources: UnifiedSettings["usageLimitSources"];
}) {
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const trimmedUrl = url.trim();
  const http = kind === "http";
  const endpoint = URL.parse(trimmedUrl);
  const canSave =
    keyValid &&
    (http
      ? endpoint !== null &&
        /^https?:$/.test(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password
      : trimmedUrl.length > 0 && managementKey !== "");

  const reset = () => {
    setLabel("");
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
  };

  const save = () => {
    if (!canSave) return;
    const id = sourceIdFromUrl(trimmedUrl, sources, kind);
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind,
          ...(label.trim() ? { label: label.trim() } : {}),
          url: trimmedUrl,
          managementKey,
          enabled: true,
        },
      },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {http ? t("Add an HTTP quota source") : t("Add a CLIProxyAPI hub")}
          </DialogTitle>
          <DialogDescription>
            {http
              ? t("Read quotas from an endpoint on {environmentLabel}.", { environmentLabel })
              : t(
                  "Show the quota of every account the hub pools, next to the providers on {environmentLabel}. The key stays on that server.",
                  { environmentLabel },
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">{http ? t("Endpoint URL") : t("Hub URL")}</Label>
              <Input
                id="usage-source-url"
                placeholder={"https://hub.example.ts.net:8318"}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-key">
                {http ? t("Bearer token (optional)") : t("Management key")}
              </Label>
              <SecretSourceInput
                id="usage-source-key"
                aria-label={http ? t("Bearer token (optional)") : t("Management key")}
                value={keyDraft}
                sources={secretSources}
                environmentId={environmentId}
                onChange={(event) => setKeyDraft(event.target.value)}
                onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                onValidityChange={setKeyValid}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">{t("Label (optional)")}</Label>
              <Input
                id="usage-source-label"
                placeholder={t("Defaults to the hub's host name")}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t("Cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            {http ? t("Add source") : t("Add hub")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
