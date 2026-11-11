import type { AddLinkedMachineRoute } from "@t3tools/client-runtime/link-request";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { PeerLinkSummary } from "@t3tools/contracts";
import { useId, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { t } from "~/i18n";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

const failureToast = (description: string) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: t("Could not add the machine to this app"),
      description,
    }),
  );

const addedToast = (name: string) =>
  toastManager.add({
    type: "success",
    title: t("Added {name} to this app", { name }),
    description: t("It now shows in the machine list and reconnects on app startup."),
  });

/**
 * Puts a machine that is linked for agents into this app's machine list. The click is the
 * user's confirmation: over T3 Connect it adds the route at once, otherwise the dialog asks
 * for a pairing code from that machine.
 */
export function AddLinkedMachineAction({
  link,
  route,
}: {
  readonly link: Pick<PeerLinkSummary, "environmentId" | "label">;
  readonly route: Exclude<AddLinkedMachineRoute, { readonly kind: "in-app" }>;
}) {
  const register = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(route.kind === "pairing" ? (route.host ?? "") : "");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const addOverConnect = async () => {
    setBusy(true);
    const result = await register(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: link.environmentId,
          label: link.label,
        }),
      }),
    );
    setBusy(false);
    if (result._tag === "Success") addedToast(link.label);
    else if (!isAtomCommandInterrupted(result)) {
      failureToast(String(squashAtomCommandFailure(result)));
    }
  };

  const addWithCode = async () => {
    if (busy || host.trim() === "" || pairingCode.trim() === "") return;
    setBusy(true);
    const result = await connectPairing({
      host: host.trim(),
      pairingCode: pairingCode.trim(),
      expectedEnvironmentId: link.environmentId,
    });
    setBusy(false);
    if (result._tag === "Success") {
      addedToast(link.label);
      setOpen(false);
      setPairingCode("");
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(String(squashAtomCommandFailure(result)));
    }
  };

  if (route.kind === "connect") {
    return (
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void addOverConnect()}>
        {busy ? t("Adding…") : t("Add to this app")}
      </Button>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            {t("Add to this app")}
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Add {name} to this app", { name: link.label })}</DialogTitle>
          <DialogDescription>
            {t(
              "The link lets agents work there. Adding it here also shows the machine in the machine list and lets you open its threads.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void addWithCode();
            }}
          >
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">{t("Address")}</span>
              <Input
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder={"https://box.example.ts.net"}
                disabled={busy}
                nativeInput
                spellCheck={false}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">{t("Pairing code")}</span>
              <Input
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                placeholder={t("Paste the code")}
                disabled={busy}
                autoComplete="one-time-code"
                autoFocus
                nativeInput
                spellCheck={false}
              />
              <span className="block text-xs text-muted-foreground">
                {t(
                  "Create a link on {name}: Settings → Connections → Create link, then paste its code here.",
                  { name: link.label },
                )}
              </span>
            </label>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            {t("Cancel")}
          </DialogClose>
          <Button
            form={formId}
            type="submit"
            disabled={busy || host.trim() === "" || pairingCode.trim() === ""}
          >
            {busy ? t("Adding…") : t("Add to this app")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
