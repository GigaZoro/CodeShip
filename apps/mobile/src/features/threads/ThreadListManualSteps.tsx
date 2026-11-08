import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { formatTimeAgo } from "@t3tools/client-runtime/scheduled-task-pins";
import {
  manualStepsFailureMessage,
  type ManualStepsState,
} from "@t3tools/client-runtime/state/manualSteps";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ManualStep } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo } from "react";
import { Linking, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { t } from "../../lib/i18n";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadShell } from "../../state/entities";
import { useManualSteps } from "../../state/manualSteps";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { ThreadListV2Section } from "./thread-list-v2-items";
import { useVisibleSecondClock } from "./use-visible-second-clock";

// The phone has no ThreadPage view, so a step opens in the browser, where ThreadPage is signed in.
const openStep = (step: ManualStep) => void Linking.openURL(step.url).catch(() => undefined);

function UpdatedAgo(props: { readonly at: string }) {
  return formatTimeAgo(props.at, useVisibleSecondClock(true));
}

const ManualStepRow = memo(function ManualStepRow(props: {
  readonly step: ManualStep;
  readonly pane: "screen" | "sidebar";
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { step, onSelectThread } = props;
  // Only a chat on a machine this phone is connected to resolves.
  const chatShell = useThreadShell(step.chat ?? null);
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
          step.step,
          step.title,
          step.machine,
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={t("Opens the step's ThreadPage thread.")}
        className={appearance.className}
        interactionClassName={appearance.interactionClassName}
        interactionOpacity={appearance.interactionOpacity}
        accessibilityActions={chatShell ? [{ name: "openChat", label: t("Open chat") }] : undefined}
        onAccessibilityAction={(event) => {
          if (chatShell && event.nativeEvent.actionName === "openChat") onSelectThread(chatShell);
        }}
        onPress={() => openStep(step)}
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
 * Above the thread list: the steps only the user can do, from every machine's ThreadPage list.
 * Hidden without a ThreadPage token or with nothing to do; it never alerts.
 */
export function ThreadListManualSteps(props: {
  readonly pane: "screen" | "sidebar";
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { state, refresh } = useManualSteps();
  const { expanded, toggle } = useManualStepsExpanded();
  if (!shown(state)) return null;
  const count = state.view.status === "listed" ? state.view.count : 0;
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
        ? state.view.groups.flatMap((group) =>
            group.steps.map((step) => (
              <ManualStepRow
                key={step.threadId}
                step={step}
                pane={props.pane}
                onSelectThread={props.onSelectThread}
              />
            )),
          )
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
