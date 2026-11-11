import { type AuthMcpClientAccess, peerLinkAccessAllowsLinkBack } from "@t3tools/contracts";

import { t } from "~/i18n";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import { LinkAccessPicker } from "./LinkAccessPicker";

/** "Also let {name} reach this machine", with what its agents may do here once it is on. */
export function LinkBackOption({
  name,
  forwardAccess,
  checked,
  onCheckedChange,
  reverseAccess,
  onReverseAccessChange,
  disabled,
}: {
  /** The machine being linked. */
  readonly name: string;
  /** The access this link gives agents there; linking back needs auto or full. */
  readonly forwardAccess: AuthMcpClientAccess;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly reverseAccess: AuthMcpClientAccess;
  readonly onReverseAccessChange: (access: AuthMcpClientAccess) => void;
  readonly disabled: boolean;
}) {
  const allowed = peerLinkAccessAllowsLinkBack(forwardAccess);
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-xs">
        <Checkbox
          checked={checked && allowed}
          disabled={disabled || !allowed}
          onCheckedChange={(next) => onCheckedChange(next === true)}
          className="mt-0.5"
        />
        <span className="space-y-1">
          <span className="block font-medium text-foreground">
            {t("Also let {name} reach this machine", { name })}
          </span>
          <span className="block text-muted-foreground">
            {allowed
              ? t(
                  "This machine links {name} back in the same step, so no second pairing code is typed there. Linked environments must be on there too.",
                  { name },
                )
              : t(
                  "{name} can link back only when this link has auto or full access. Otherwise link this machine from {name}.",
                  { name },
                )}
          </span>
        </span>
      </label>
      {checked && allowed ? (
        <LinkAccessPicker
          value={reverseAccess}
          onChange={onReverseAccessChange}
          disabled={disabled}
          label={t("What agents there may do here")}
          note={t("An agent there never gets more access here than its own mode there.")}
        />
      ) : null}
    </div>
  );
}

/** The link stands, but `name` cannot reach this machine yet. */
export function toastLinkBackMissing(name: string, here: string | null) {
  toastManager.add({
    type: "warning",
    title: t("Linked {name}, but it cannot reach this machine yet", { name }),
    description: t("Link {here} from {name} to let it reach this machine.", {
      here: here ?? t("this machine"),
      name,
    }),
  });
}
