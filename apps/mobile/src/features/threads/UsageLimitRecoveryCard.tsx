import { useNavigation } from "@react-navigation/native";
import { CHATGPT_APP_CAP_CODE } from "@t3tools/shared/usageLimits";
import { Button } from "../../components/ui/Button";
import { RetryAccountButton } from "../usage/RetryAccountButton";
import { openSettings } from "../settings/settings-navigation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useDeadlinePassed } from "../../lib/clock";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { getFormattingLocale, t } from "../../lib/i18n";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  const appCap = thread.runtime?.lastErrorCode === CHATGPT_APP_CAP_CODE;
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  if (
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    !runId
  )
    return null;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    thread.snoozedUntil !== null &&
    Date.parse(thread.snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError(t("The reset time has passed. Retry the thread manually."));
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: thread.id,
        limitRecovery: {
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        },
      },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : t("Could not change limit recovery."));
    }
  }
  const instanceId = thread.runtime.providerInstanceId;
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      {appCap ? (
        <>
          <Text accessibilityRole="header" className="text-sm font-t3-medium text-foreground">
            {t("ChatGPT's app limit stopped this account")}
          </Text>
          <Text className="text-sm text-warning-foreground">
            {t(
              "The plan still has room, and no ChatGPT setting lifts this limit. Try again, or sign the account in with Codex's own login. CodeShip tries it again by itself every hour.",
            )}
          </Text>
          {instanceId ? (
            <View className="flex-row flex-wrap gap-2">
              <RetryAccountButton environmentId={environmentId} instanceId={instanceId} />
              <Button
                label={t("Switch sign-in")}
                tone="secondary"
                onPress={() =>
                  openSettings(navigation, "SettingsProviderAccounts", {
                    environmentId,
                    instanceId,
                  })
                }
              />
            </View>
          ) : null}
        </>
      ) : (
        <Text className="text-sm text-warning-foreground">
          {resetAt
            ? t("Usage limit resets {date}.", {
                date: DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString(
                  getFormattingLocale(),
                ),
              })
            : t(
                "The provider did not report a reset time. Retry manually when your limit is available.",
              )}
        </Text>
      )}
      {canSchedule ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={scheduled ? t("Cancel auto-resume") : t("Resume at reset")}
            tone="secondary"
            disabled={pending}
            onPress={() => void toggle("resume")}
          />
          <Button
            label={snoozed ? t("Wake now") : t("Snooze until reset")}
            tone="secondary"
            disabled={pending || (!snoozed && resetPassed)}
            onPress={() => void toggle("snooze")}
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
