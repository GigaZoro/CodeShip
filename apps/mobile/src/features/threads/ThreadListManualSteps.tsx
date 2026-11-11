import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { formatTimeAgo } from "@t3tools/client-runtime/scheduled-task-pins";
import { useNavigation } from "@react-navigation/native";
import {
  detectedManualStepText,
  manualStepsFailureMessage,
  detectedManualStepKey,
  type DetectedManualStepEntry,
  type ManualStepsState,
} from "@t3tools/client-runtime/state/manualSteps";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ManualStep } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { getFormattingLocale, t } from "../../lib/i18n";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadShell } from "../../state/entities";
import { useManualStepReview, useManualSteps } from "../../state/manualSteps";
import { openSettings } from "../settings/settings-navigation";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { ThreadListV2Section } from "./thread-list-v2-items";
import { useVisibleSecondClock } from "./use-visible-second-clock";

function UpdatedAgo(props: { readonly at: string }) {
  return formatTimeAgo(props.at, useVisibleSecondClock(true));
}

const ManualStepRow = memo(function ManualStepRow(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId | null;
  readonly pane: "screen" | "sidebar";
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { step, onSelectThread } = props;
  // Only a chat on a machine this phone is connected to resolves.
  const chatShell = useThreadShell(step.chat ?? null);
  const navigation = useNavigation();
  // Asking here reviews every listed step, so its review is ready when it is opened.
  const review = useManualStepReview(step, props.reviewEnvironmentId).state;
  const agentCanDo = review?.status === "ready" && !review.review.needsPerson;
  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const appearance = getThreadListV2RowAppearance(theme, sidebarPane, false);
  const money = step.kind === "needs-you";
  const content = (
    <>
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={money ? "dollarsign.circle" : "hand.raised"}
          size={14}
          tintColorClassName={
            money ? "accent-warning-foreground" : appearance.mutedIconTintClassName
          }
          type="monochrome"
        />
        <Text
          className={cn("flex-1 text-base font-t3-medium", appearance.foregroundClassName)}
          numberOfLines={1}
        >
          {step.step}
        </Text>
        {agentCanDo ? (
          <SymbolView
            name="bot"
            size={14}
            tintColorClassName={appearance.mutedIconTintClassName}
            type="monochrome"
            accessibilityLabel={t("An agent can do this.")}
          />
        ) : null}
        <Text className={cn("text-xs tabular-nums", appearance.mutedForegroundClassName)}>
          <UpdatedAgo at={step.updatedAt} />
        </Text>
      </View>
      <View className="mt-1 flex-row items-center gap-2">
        {money ? (
          <Text className="text-xs font-t3-medium text-warning-foreground">{t("Money")}</Text>
        ) : null}
        <Text
          className={cn("flex-1 text-xs", appearance.mutedForegroundClassName)}
          numberOfLines={1}
        >
          {step.title}
        </Text>
        {chatShell ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onSelectThread(chatShell)}
          >
            <Text className="text-xs font-t3-medium text-primary">{t("Open chat")}</Text>
          </Pressable>
        ) : null}
        <Text
          className={cn("max-w-[40%] shrink-0 text-xs", appearance.mutedForegroundClassName)}
          numberOfLines={1}
        >
          {step.machine}
        </Text>
      </View>
    </>
  );
  return (
    <View style={appearance.swipeContainerStyle}>
      <RowPressable
        accessibilityRole="link"
        accessibilityLabel={[
          money ? t("Money decision") : null,
          agentCanDo ? t("An agent can do this.") : null,
          step.step,
          step.title,
          step.machine,
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={t("Opens the step and its review.")}
        className={appearance.className}
        interactionClassName={appearance.interactionClassName}
        interactionOpacity={appearance.interactionOpacity}
        accessibilityActions={chatShell ? [{ name: "openChat", label: t("Open chat") }] : undefined}
        onAccessibilityAction={(event) => {
          if (chatShell && event.nativeEvent.actionName === "openChat") onSelectThread(chatShell);
        }}
        onPress={() => navigation.navigate("ManualStep", { threadId: step.threadId })}
        style={appearance.cardStyle}
      >
        {sidebarPane ? (
          content
        ) : (
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{content}</View>
            {THREAD_LIST_V2_ROW_DIVIDERS ? <View className="ml-5 h-px bg-border-subtle" /> : null}
          </View>
        )}
      </RowPressable>
    </View>
  );
});

const formatLoginDate = (iso: string) =>
  new Intl.DateTimeFormat(getFormattingLocale(), { dateStyle: "medium" }).format(new Date(iso));

/** A sign-in this machine's server noticed; it opens the settings page that holds the fix. */
const DetectedStepRow = memo(function DetectedStepRow(props: {
  readonly entry: DetectedManualStepEntry;
  readonly pane: "screen" | "sidebar";
}) {
  const { entry } = props;
  const navigation = useNavigation();
  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const appearance = getThreadListV2RowAppearance(theme, sidebarPane, false);
  const text = detectedManualStepText(entry.step, {
    driverLabel: providerClients.get(entry.step.driver)?.label ?? entry.step.driver,
    formatDate: formatLoginDate,
  });
  const lapsed = entry.step.kind === "login-expired";
  const content = (
    <>
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={{ ios: "key", android: "lock" }}
          size={14}
          tintColorClassName={lapsed ? "accent-danger-foreground" : "accent-warning-foreground"}
          type="monochrome"
        />
        <Text
          className={cn("flex-1 text-base font-t3-medium", appearance.foregroundClassName)}
          numberOfLines={1}
        >
          {text.step}
        </Text>
        <Text className="text-xs font-t3-medium text-primary">{t("Sign in")}</Text>
      </View>
      <View className="mt-1 flex-row items-center gap-2">
        <Text
          className={cn(
            "flex-1 text-xs",
            lapsed ? "font-t3-medium text-danger-foreground" : appearance.mutedForegroundClassName,
          )}
          numberOfLines={1}
        >
          {text.detail}
        </Text>
        <Text
          className={cn("max-w-[40%] shrink-0 text-xs", appearance.mutedForegroundClassName)}
          numberOfLines={1}
        >
          {entry.step.machine}
        </Text>
      </View>
    </>
  );
  return (
    <View style={appearance.swipeContainerStyle}>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[text.step, text.detail, entry.step.machine].join(", ")}
        accessibilityHint={
          entry.step.kind === "mcp-needs-auth"
            ? t("Opens Capabilities, where the MCP server signs in.")
            : t("Opens Providers, where the account signs in.")
        }
        className={appearance.className}
        interactionClassName={appearance.interactionClassName}
        interactionOpacity={appearance.interactionOpacity}
        onPress={() =>
          entry.step.kind === "mcp-needs-auth"
            ? openSettings(navigation, "SettingsCapabilities", {
                environmentId: entry.environmentId,
                instanceId: entry.step.instanceId,
                ...(entry.step.serverName !== undefined ? { server: entry.step.serverName } : {}),
              })
            : openSettings(navigation, "SettingsProviderAccounts")
        }
        style={appearance.cardStyle}
      >
        {sidebarPane ? (
          content
        ) : (
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{content}</View>
            {THREAD_LIST_V2_ROW_DIVIDERS ? <View className="ml-5 h-px bg-border-subtle" /> : null}
          </View>
        )}
      </RowPressable>
    </View>
  );
});

function useManualStepsExpanded() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const expanded = !loaded || preferences.value.threadListManualStepsExpanded !== false;
  const toggle = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListManualStepsExpanded: current.threadListManualStepsExpanded === false,
      }),
    });
  };
  return { expanded, toggle };
}

function shown(state: ManualStepsState | null): state is ManualStepsState {
  if (state === null) return false;
  return state.view.status === "failed" || (state.view.status === "listed" && state.view.count > 0);
}

/**
 * Above the thread list: the sign-ins each machine notices itself, then the steps only the user can
 * do from every machine's ThreadPage list. Hidden with nothing to do; it never alerts.
 */
export function ThreadListManualSteps(props: {
  readonly pane: "screen" | "sidebar";
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { state, refresh } = useManualSteps();
  const { expanded, toggle } = useManualStepsExpanded();
  if (!shown(state)) return null;
  const count = state.view.status === "listed" ? state.view.count : 0;
  const reviewEnvironmentId =
    state.view.status === "listed" ? state.view.reviewEnvironmentId : null;
  const label = t("Manual steps");
  return (
    <View className={cn(props.pane === "sidebar" && "pb-2")}>
      <ThreadListV2Section
        label={expanded || count === 0 ? label : t("{label} ({count})", { label, count })}
        pane={props.pane}
        disclosure={{
          expanded,
          onToggle: toggle,
          accessibilityLabel: t("Manual steps ({count})", { count }),
          accessibilityHint: expanded
            ? t("Collapses the manual steps.")
            : t("Expands the manual steps."),
        }}
      />
      {expanded && state.view.status === "listed"
        ? state.view.groups.flatMap((group) => [
            ...group.detected.map((entry) => (
              <DetectedStepRow key={detectedManualStepKey(entry)} entry={entry} pane={props.pane} />
            )),
            ...group.steps.map((step) => (
              <ManualStepRow
                key={step.threadId}
                step={step}
                reviewEnvironmentId={reviewEnvironmentId}
                pane={props.pane}
                onSelectThread={props.onSelectThread}
              />
            )),
          ])
        : null}
      {expanded && state.view.status === "failed" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint={t("Reads ThreadPage again.")}
          className={props.pane === "sidebar" ? "px-3 py-2" : "px-5 py-2"}
          onPress={refresh}
        >
          <Text className="text-sm text-destructive-foreground">
            {manualStepsFailureMessage(state.view.reason)}
          </Text>
          <Text className="mt-1 text-sm font-t3-medium text-primary">{t("Retry")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
