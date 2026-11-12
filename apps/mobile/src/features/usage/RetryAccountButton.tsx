import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Ends the account's hold so its next turn tries it again, and says how that went. */
export function RetryAccountButton({
  environmentId,
  instanceId,
  resumes = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  /** The chat is set to resume, so the server continues it once the account has room. */
  readonly resumes?: boolean;
}) {
  const retryUsageLimit = useAtomCommand(serverEnvironment.retryUsageLimit, {
    reportFailure: false,
  });
  const permitted = useAtomValue(serverEnvironment.retryUsageLimit.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  async function retry() {
    setPending(true);
    setOutcome(null);
    const result = await retryUsageLimit({ environmentId, input: { instanceId } });
    setPending(false);
    if (result._tag === "Success") {
      setOutcome({ ok: true });
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setOutcome({
      ok: false,
      message: cause instanceof Error ? cause.message : t("An error occurred."),
    });
  }
  if (!permitted) return null;
  return (
    <View className="gap-1">
      <Button
        label={pending ? t("Saving...") : t("Try again")}
        tone="secondary"
        disabled={pending}
        onPress={() => void retry()}
      />
      {outcome ? (
        <View
          accessible
          accessibilityRole={outcome.ok ? undefined : "alert"}
          accessibilityLiveRegion="polite"
        >
          <Text
            className={
              outcome.ok
                ? "text-sm font-t3-medium text-foreground"
                : "text-sm font-t3-medium text-destructive"
            }
          >
            {outcome.ok ? t("Account released") : t("Could not release the account")}
          </Text>
          <Text
            className={outcome.ok ? "text-sm text-foreground-muted" : "text-sm text-destructive"}
          >
            {outcome.ok
              ? resumes
                ? t("The chat continues on it within a minute.")
                : t("Send a message to try the account again.")
              : outcome.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
