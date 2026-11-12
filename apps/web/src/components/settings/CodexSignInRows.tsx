import {
  codexPrivateLoginApplies,
  readCodexPrivateLogin,
  readCodexSignInMode,
  type CodexSignInMode,
} from "@t3tools/client-runtime/codex-sign-in";
import {
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { t } from "~/i18n";
import { managedInstanceLocks } from "@t3tools/shared/managedPolicyMessages";
import { useManagedPolicy } from "../../state/managedPolicy";
import { ManagedControl } from "../ManagedPolicy";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

const SIGN_IN_LABELS: Record<CodexSignInMode, () => string> = {
  managed: () => t("ChatGPT sign-in"),
  existing: () => t("Codex's own login"),
};

const SIGN_IN_MODES: readonly CodexSignInMode[] = ["managed", "existing"];

/** Where an account signs in: CodeShip's ChatGPT sign-in, or the login Codex keeps for itself. */
export function CodexSignInRows({
  environmentId,
  instanceId,
  config,
  readOnly,
  onModeChange,
  onPrivateLoginChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
  readonly readOnly: boolean;
  readonly onModeChange: (mode: CodexSignInMode) => void;
  readonly onPrivateLoginChange: (privateLogin: boolean) => void;
}) {
  const locks = managedInstanceLocks(
    useManagedPolicy(environmentId),
    ProviderDriverKind.make("codex"),
  );
  const mode = readCodexSignInMode(config);
  const lockReason = locks?.configKeys.has("setupMode") ? locks.reason : undefined;
  return (
    <>
      <SettingsRow
        title={t("Sign-in")}
        description={
          mode === "managed"
            ? t("CodeShip signs this account in with ChatGPT.")
            : t("This account uses the login Codex keeps for itself.")
        }
        control={
          <ManagedControl reason={lockReason}>
            <Select
              value={mode}
              disabled={readOnly}
              onValueChange={(next) => {
                if (next !== null && next !== mode) onModeChange(next as CodexSignInMode);
              }}
            >
              <SelectTrigger aria-label={t("Sign-in")} className="min-w-44" size="sm">
                <SelectValue>{SIGN_IN_LABELS[mode]()}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {SIGN_IN_MODES.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {SIGN_IN_LABELS[candidate]()}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </ManagedControl>
        }
      />
      {mode === "existing" && codexPrivateLoginApplies(instanceId, config) ? (
        <SettingsRow
          title={t("Private login")}
          description={t("Signs this account in apart from the Codex CLI on this machine.")}
          control={
            <Switch
              checked={readCodexPrivateLogin(config)}
              disabled={readOnly}
              onCheckedChange={(checked) => onPrivateLoginChange(Boolean(checked))}
              aria-label={t("Private login")}
            />
          }
        />
      ) : null}
    </>
  );
}
