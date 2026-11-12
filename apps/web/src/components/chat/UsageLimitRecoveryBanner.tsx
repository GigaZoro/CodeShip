import {
  type EnvironmentId,
  type ProviderInstanceId,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import {
  CHATGPT_APP_CAP_CODE,
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Button } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { RetryAccountButton } from "./RetryAccountButton";
import { copyAdminRequest } from "./ThreadErrorBanner";
import { t } from "~/i18n";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** Ends the account's hold so its next turn tries it again; absent when the account is unknown. */
  onRetryAccount?: () => Promise<void>;
  /** The account's provider settings, where its sign-in can be switched. */
  signInSettings?: { environmentId: EnvironmentId; instanceId: ProviderInstanceId };
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, errorCode, resetAt, stoppedAt, timestampFormat } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const appCap = errorCode === CHATGPT_APP_CAP_CODE;
  const chatGptLimit = workspaceLimit || appCap || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions = canSchedule ? (
    <RecoveryActions key={`${runId}:${resetAt}`} {...props} />
  ) : null;
  const resetDescription = resetAt
    ? t("Resets {time}", { time: formatUpcomingTimestamp(resetAt, timestampFormat) })
    : t("Reset time unavailable; retry manually");
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      icon: <GaugeIcon />,
      title: t("Usage limit reached"),
      description: resetDescription,
      actions: recoveryActions,
    };
  }
  if (appCap) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      icon: <OpenAI aria-hidden="true" />,
      title: t("ChatGPT's app limit stopped this account"),
      description: t(
        "The plan still has room, and no ChatGPT setting lifts this limit. Try again, or sign the account in with Codex's own login. CodeShip tries it again by itself every hour.",
      ),
      actions: (
        <>
          {props.onRetryAccount ? (
            <RetryAccountButton
              onRetry={props.onRetryAccount}
              resumes={resumeScheduled(props) && !snoozedUntilReset(props)}
            />
          ) : null}
          {props.signInSettings ? (
            <Button
              size="xs"
              variant="ghost"
              render={<Link to="/settings/providers" search={props.signInSettings} />}
            >
              {t("Switch sign-in")}
            </Button>
          ) : null}
          {recoveryActions}
        </>
      ),
    };
  }
  // OpenAI's partner guidelines specify this ChatGPT notice and its actions.
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    icon: <OpenAI aria-hidden="true" />,
    title: t("ChatGPT usage limit reached"),
    description: workspaceLimit
      ? t("You've reached your workspace's limit for using your ChatGPT plan in other apps.")
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            {t("Copy request for admin")}
          </Button>
        ) : (
          <ChatGptUsageButton size="xs" variant="ghost" />
        )}
      </>
    ),
  };
}

function resumeScheduled({ runId, resetAt, recovery }: RecoveryProps): boolean {
  return recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
}

/** A snooze holds the chat until the reset, even when its account has room sooner. */
function snoozedUntilReset({ runId, resetAt, recovery, snoozedUntil }: RecoveryProps): boolean {
  return (
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt)
  );
}

function RecoveryActions(props: RecoveryProps) {
  const { runId, resetAt, onChange } = props;
  const [pending, setPending] = useState(false);

  const scheduled = resumeScheduled(props);
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed = snoozedUntilReset(props) && !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: t("Could not snooze thread"),
        description: t("The reset time has passed. Retry the thread manually."),
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title:
          action === "resume" ? t("Could not change auto-resume") : t("Could not snooze thread"),
        description: cause instanceof Error ? cause.message : t("An error occurred."),
      });
    }
    setPending(false);
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <>
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? t("Saving...") : scheduled ? t("Cancel auto-resume") : t("Resume at reset")}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending ? t("Saving...") : snoozed ? t("Wake now") : t("Snooze until reset")}
      </Button>
    </>
  );
}
