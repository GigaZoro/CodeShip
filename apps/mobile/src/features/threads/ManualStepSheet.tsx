import { formatTimeAgo } from "@t3tools/client-runtime/scheduled-task-pins";
import {
  manualStepChatHost,
  manualStepReviewFailureMessage,
  manualStepSolutionDecision,
  manualStepStartChatFailureMessage,
  sameManualStepDecision,
  type ManualStepChatHost,
} from "@t3tools/client-runtime/state/manualSteps";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  MANUAL_STEP_DECISION_MAX_LENGTH,
  type EnvironmentId,
  type ManualStep,
  type ManualStepDecision,
  type ManualStepReview,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { t } from "../../lib/i18n";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useThreadShell } from "../../state/entities";
import {
  useManualStepReview,
  useManualSteps,
  useReviewAgain,
  useStartManualStepChat,
} from "../../state/manualSteps";
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

interface StepDecision {
  /** The decision whose chat is starting; every other choice waits for it. */
  readonly pending: ManualStepDecision | null;
  readonly failure: string | null;
  /** The chat this session already started for the step. */
  readonly started: ScopedThreadRef | null;
  readonly decide: (decision: ManualStepDecision) => void;
  readonly openChat: (chat: ScopedThreadRef) => void;
}

/** Sends a decision to `host` and opens the chat that carries it out. */
function useStepDecision(step: ManualStep, host: ManualStepChatHost | null): StepDecision | null {
  const { pending, started, start } = useStartManualStepChat(step);
  const navigation = useNavigation();
  const [failure, setFailure] = useState<string | null>(null);
  if (host === null) return null;
  const openChat = (chat: ScopedThreadRef) =>
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: chat.environmentId,
        threadId: chat.threadId,
      }),
    );
  const decide = (decision: ManualStepDecision) => {
    const starting = start(host.environmentId, decision);
    if (starting === null) return;
    setFailure(null);
    void starting.then((result) => {
      if (result._tag === "Success") {
        // The chat opens only while this sheet is in front; later the sheet links to it.
        if (navigation.isFocused()) {
          openChat({ environmentId: host.environmentId, threadId: result.value.threadId });
        }
      } else if (!isAtomCommandInterrupted(result)) {
        setFailure(manualStepStartChatFailureMessage(result.cause));
      }
    });
  };
  return { pending, failure, started, decide, openChat };
}

function SolutionList(props: {
  readonly solutions: ManualStepReview["solutions"];
  readonly decision: StepDecision | null;
}) {
  const { decision } = props;
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
          {decision === null ? null : <SolutionChoice decision={decision} solution={solution} />}
        </View>
      ))}
    </View>
  );
}

function SolutionChoice(props: {
  readonly decision: StepDecision;
  readonly solution: ManualStepReview["solutions"][number];
}) {
  const { decision, solution } = props;
  const own = manualStepSolutionDecision(solution);
  const sending = decision.pending !== null && sameManualStepDecision(decision.pending, own);
  return (
    <Button
      label={t("Choose")}
      accessibilityLabel={t("Choose: {solution}", { solution: solution.title })}
      disabled={decision.pending !== null && !sending}
      loading={sending}
      onPress={() => decision.decide(own)}
    />
  );
}

/** The user's own decision, the chat already started, and why a chat did not start. */
function DecisionFooter(props: { readonly decision: StepDecision; readonly machine: string }) {
  const { decision } = props;
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const { started } = decision;
  const sending = decision.pending?._tag === "Other";
  return (
    <View className="gap-3">
      <View className="gap-1.5">
        <Text className="text-base font-t3-medium text-foreground">{t("Your decision")}</Text>
        <Text className="text-xs text-foreground-muted">
          {t("Your choice starts a chat on {machine} that carries it out.", {
            machine: props.machine,
          })}
        </Text>
        <TextInput
          multiline
          accessibilityLabel={t("Your decision")}
          placeholder={t("Say what to do, in your own words.")}
          placeholderTextColorClassName="accent-foreground-muted"
          editable={!sending}
          value={text}
          maxLength={MANUAL_STEP_DECISION_MAX_LENGTH}
          onChangeText={setText}
          className="min-h-20 rounded-[20px] bg-subtle p-4 text-base text-foreground"
          style={{ textAlignVertical: "top" }}
        />
        <Text
          className="self-end text-xs text-foreground-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {text.length} / {MANUAL_STEP_DECISION_MAX_LENGTH}
        </Text>
        <Button
          label={t("Start chat")}
          tone="primary"
          disabled={trimmed.length === 0 || (decision.pending !== null && !sending)}
          loading={sending}
          onPress={() => decision.decide({ _tag: "Other", text: trimmed })}
        />
      </View>
      {decision.failure === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-destructive-foreground">
          {decision.failure}
        </Text>
      )}
      {started === null ? null : (
        <View className="items-start gap-2">
          <Text className="text-sm text-foreground-muted">
            {t("A chat is carrying out your decision.")}
          </Text>
          <Button label={t("Open that chat")} onPress={() => decision.openChat(started)} />
        </View>
      )}
    </View>
  );
}

function ReviewedAgo(props: { readonly at: string }) {
  return t("Reviewed {time}", { time: formatTimeAgo(props.at, useVisibleSecondClock(true)) });
}

function ReviewBody(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId | null;
  readonly decision: StepDecision | null;
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
          <SolutionList solutions={state.review.solutions} decision={props.decision} />
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
  readonly chatHost: ManualStepChatHost | null;
}) {
  const { step, chatHost } = props;
  const navigation = useNavigation();
  const decision = useStepDecision(step, chatHost);
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
      <ReviewBody step={step} reviewEnvironmentId={props.reviewEnvironmentId} decision={decision} />
      {decision === null || chatHost === null ? null : (
        <DecisionFooter decision={decision} machine={chatHost.machine} />
      )}
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
  const chatHost =
    view?.status === "listed" && step !== null ? manualStepChatHost(view, step.machine) : null;

  const content = (
    <ScrollView
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
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
        <StepContent step={step} reviewEnvironmentId={reviewEnvironmentId} chatHost={chatHost} />
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
