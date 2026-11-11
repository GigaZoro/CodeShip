import { formatTimeAgo } from "@t3tools/client-runtime/scheduled-task-pins";
import { manualStepReviewFailureMessage } from "@t3tools/client-runtime/state/manualSteps";
import type { EnvironmentId, ManualStep, ManualStepReview } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { t } from "../../lib/i18n";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useThreadShell } from "../../state/entities";
import { useManualStepReview, useManualSteps, useReviewAgain } from "../../state/manualSteps";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

function CopyCommand(props: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await Clipboard.setStringAsync(props.command).catch(() => undefined);
    setCopied(true);
  };
  return (
    <View className="gap-1.5 rounded-xl bg-subtle p-3">
      <Text selectable className="font-mono text-sm text-foreground">
        {props.command}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Copy command")}
        hitSlop={8}
        className="self-start active:opacity-70"
        onPress={() => void copy()}
      >
        <Text className="text-sm font-t3-medium text-primary-text">
          {copied ? t("Copied") : t("Copy")}
        </Text>
      </Pressable>
    </View>
  );
}

function SolutionList(props: { readonly solutions: ManualStepReview["solutions"] }) {
  return (
    <View className="gap-4">
      {props.solutions.map((solution, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- the model may repeat a title, so a solution is its position
        <View key={index} className="gap-1.5">
          <Text className="text-base font-t3-medium text-foreground">
            {index + 1}. {solution.title}
          </Text>
          <View className="flex-row flex-wrap items-center gap-x-2">
            {index === 0 ? (
              <Text className="text-xs font-t3-medium text-primary-text">{t("Recommended")}</Text>
            ) : null}
            <Text className="text-xs text-foreground-muted">
              {solution.agentCanDo ? t("Agent can do it") : t("Only you")}
            </Text>
          </View>
          <Text className="text-sm text-foreground-muted">{solution.detail}</Text>
          {solution.command === undefined ? null : <CopyCommand command={solution.command} />}
        </View>
      ))}
    </View>
  );
}

function ReviewedAgo(props: { readonly at: string }) {
  return t("Reviewed {time}", { time: formatTimeAgo(props.at, useVisibleSecondClock(true)) });
}

function ReviewBody(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId | null;
}) {
  const { step, reviewEnvironmentId } = props;
  const { state, retry } = useManualStepReview(step, reviewEnvironmentId);
  const { allowed, running, reviewAgain } = useReviewAgain(step, reviewEnvironmentId);
  return (
    <>
      {state === null ? null : state.status === "loading" ? (
        <View accessibilityRole="summary" className="gap-2">
          <Text className="text-sm text-foreground-muted">{t("Reviewing…")}</Text>
          <View aria-hidden className="h-3.5 w-4/5 rounded-sm bg-subtle-strong" />
          <View aria-hidden className="h-3.5 w-3/5 rounded-sm bg-subtle-strong" />
        </View>
      ) : state.status === "failed" ? (
        <View accessibilityRole="alert" className="items-start gap-2">
          <Text className="text-sm text-destructive-foreground">
            {manualStepReviewFailureMessage(state.reason)}
          </Text>
          <Button label={t("Retry")} onPress={retry} />
        </View>
      ) : (
        <View className="gap-4">
          <View className="gap-1">
            <View className="flex-row items-center gap-1.5">
              <SymbolView
                name={state.review.needsPerson ? "hand.raised" : "bot"}
                size={16}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
              <Text className="text-base font-t3-medium text-foreground">
                {state.review.needsPerson ? t("Needs you") : t("An agent can do this")}
              </Text>
            </View>
            <Text className="text-sm text-foreground-muted">{state.review.summary}</Text>
          </View>
          <SolutionList solutions={state.review.solutions} />
          <Text className="text-xs text-foreground-muted">
            <ReviewedAgo at={state.review.generatedAt} />
          </Text>
        </View>
      )}
      {reviewEnvironmentId === null ? null : (
        <Button
          label={t("Review again")}
          disabled={!allowed || state?.status === "loading"}
          loading={running}
          onPress={() => void reviewAgain()}
        />
      )}
    </>
  );
}

function StepContent(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId | null;
}) {
  const { step } = props;
  const navigation = useNavigation();
  const chatShell = useThreadShell(step.chat ?? null);
  const money = step.kind === "needs-you";
  return (
    <View className="gap-5">
      <View className="gap-1">
        <View className="flex-row items-start gap-1.5">
          <SymbolView
            name={money ? "dollarsign.circle" : "hand.raised"}
            size={16}
            tintColorClassName={money ? "accent-warning-foreground" : "accent-foreground-muted"}
            type="monochrome"
          />
          <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
            {step.step}
          </Text>
        </View>
        <Text className="text-xs text-foreground-muted">
          {[money ? t("Money") : null, step.title, step.machine].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <ReviewBody step={step} reviewEnvironmentId={props.reviewEnvironmentId} />
      <View className="flex-row flex-wrap gap-3">
        <Button
          label={t("Open in ThreadPage")}
          onPress={() => void Linking.openURL(step.url).catch(() => undefined)}
        />
        {chatShell ? (
          <Button
            label={t("Open chat")}
            onPress={() =>
              navigation.dispatch(
                StackActions.replace("Thread", {
                  environmentId: chatShell.environmentId,
                  threadId: chatShell.id,
                }),
              )
            }
          />
        ) : null}
      </View>
    </View>
  );
}

/** One manual step with its AI review: the verdict, ways to get it done, and commands to copy. */
export function ManualStepSheet({ route }: StaticScreenProps<{ readonly threadId: string }>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { state } = useManualSteps();
  const view = state?.view;
  const step =
    view?.status === "listed"
      ? (view.groups
          .flatMap((group) => group.steps)
          .find((candidate) => candidate.threadId === route.params.threadId) ?? null)
      : null;
  const listed = view?.status === "listed";
  const reviewEnvironmentId = view?.status === "listed" ? view.reviewEnvironmentId : null;

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pt-4 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {step === null ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          {listed ? t("This step is no longer waiting in ThreadPage.") : t("Loading…")}
        </Text>
      ) : (
        <StepContent step={step} reviewEnvironmentId={reviewEnvironmentId} />
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="manual-step-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title={t("Manual step")}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title={t("Manual step")} onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
