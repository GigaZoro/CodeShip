import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { useState } from "react";

import { t } from "~/i18n";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  draftFromSecretProvider,
  secretProviderFromDraft,
  type SecretProviderAuth,
  type SecretProviderDraft,
} from "./SecretProviderDialog.logic";

/** Mounted per open, so each open starts from a fresh draft. */
export function SecretProviderDialog({
  onClose,
  environmentId,
  environmentLabel,
  serviceAccountSupported,
  existingIds,
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly serviceAccountSupported: boolean;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: SecretProviderId; readonly config: SecretProviderConfig };
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const initialDraft = draftFromSecretProvider(existing?.config);
  const [draft, setDraft] = useState(initialDraft);
  const [submitted, setSubmitted] = useState(false);
  const serviceAccountAllowed =
    serviceAccountSupported || initialDraft.auth === "linux-service-account";
  const authUnavailable = draft.auth === "linux-service-account" && !serviceAccountAllowed;
  const result = secretProviderFromDraft(
    draft,
    existingIds,
    existing ? { mode: "edit", id: existing.id } : { mode: "add" },
  );
  const issues = Result.isFailure(result) ? result.failure : {};
  const nameError = submitted ? issues.name : undefined;
  const accountError = submitted ? issues.account : undefined;

  const update = (patch: Partial<SecretProviderDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (authUnavailable || Result.isFailure(result)) return;
    updateSettings({ secretProviders: { [result.success.id]: result.success.config } });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? t("Edit {name}", { name: existing.config.label })
              : t("Add a 1Password provider")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Provider variables on {environment} can read values from it by name. Values are read with the op CLI on that server when a provider starts.",
              { environment: environmentLabel },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="secret-provider-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-name">{t("Name")}</Label>
              <Input
                id="secret-provider-name"
                placeholder={t("Personal")}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={nameError !== undefined}
                aria-describedby={
                  nameError !== undefined ? "secret-provider-name-error" : undefined
                }
                autoFocus
              />
              {nameError !== undefined ? (
                <p
                  id="secret-provider-name-error"
                  role="alert"
                  className="text-xs text-destructive-foreground"
                >
                  {nameError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-auth">{t("Authentication method")}</Label>
              <Select<SecretProviderAuth>
                value={draft.auth}
                onValueChange={(auth) => {
                  if (auth !== null) update({ auth });
                }}
              >
                <SelectTrigger
                  id="secret-provider-auth"
                  aria-invalid={authUnavailable}
                  aria-describedby={
                    !serviceAccountSupported ? "secret-provider-auth-unavailable" : undefined
                  }
                >
                  <SelectValue>
                    {draft.auth === "desktop"
                      ? t("Desktop integration")
                      : t("Linux service account")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="desktop">{t("Desktop integration")}</SelectItem>
                  <SelectItem value="linux-service-account" disabled={!serviceAccountAllowed}>
                    {t("Linux service account")}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {!serviceAccountSupported ? (
                <p id="secret-provider-auth-unavailable" className="text-xs text-muted-foreground">
                  {t("This host does not support Linux service accounts.")}
                </p>
              ) : null}
            </div>
            {draft.auth === "desktop" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="secret-provider-account">{t("Account")}</Label>
                <Input
                  id="secret-provider-account"
                  placeholder={"my.1password.com"}
                  value={draft.account}
                  onChange={(event) => update({ account: event.target.value })}
                  maxLength={253}
                  spellCheck={false}
                  aria-invalid={accountError !== undefined}
                  aria-describedby={
                    accountError !== undefined ? "secret-provider-account-error" : undefined
                  }
                />
                {accountError !== undefined ? (
                  <p
                    id="secret-provider-account-error"
                    role="alert"
                    className="text-xs text-destructive-foreground"
                  >
                    {accountError}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {t(
                    "The account shorthand, sign-in address without https://, or ID that op account list shows.",
                  )}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Ask the host administrator to set up a 1Password service account and allow the fields CodeShip may read without prompts.",
                )}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            form="secret-provider-form"
            disabled={authUnavailable || (submitted && Result.isFailure(result))}
          >
            {existing ? t("Save changes") : t("Add provider")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
