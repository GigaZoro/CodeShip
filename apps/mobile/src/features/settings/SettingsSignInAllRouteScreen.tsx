import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import {
  detectedManualStepAccountLabel,
  detectedManualStepText,
  type DetectedManualStepEntry,
} from "@t3tools/client-runtime/state/manualSteps";
import {
  signInOutcomeText,
  signInPendingCountText,
  signInPositionText,
} from "@t3tools/client-runtime/state/manualStepsSignIn";
import {
  currentSignIn,
  mcpSignInProgress,
  outcomeOfProgress,
  providerReadsSignedIn,
  providerSignInProgress,
  providerSignInUnsupportedOnPhone,
  recordSignInOutcome,
  startSignInSession,
  summarizeSignIns,
  type SignInOutcome,
  type SignInProgress,
  type SignInSession,
} from "@t3tools/client-runtime/state/manualStepsSignIn.logic";
import { AuthProvidersManageScope, type ProviderMcpServerName } from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { getFormattingLocale, t } from "../../lib/i18n";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useManualSteps } from "../../state/manualSteps";
import { McpSignInBody } from "./SettingsMcpSignInRouteScreen";
import { ProviderAccount } from "./SettingsProviderAccountsRouteScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

type Props = StaticScreenProps<{
  /** The machine whose sign-ins to walk, as the Manual steps list names it. */
  readonly machine: string;
}>;

const formatLoginDate = (iso: string) =>
  new Intl.DateTimeFormat(getFormattingLocale(), { dateStyle: "medium" }).format(new Date(iso));

const stepText = (entry: DetectedManualStepEntry) =>
  detectedManualStepText(entry.step, {
    driverLabel: providerClients.get(entry.step.driver)?.label ?? entry.step.driver,
    formatDate: formatLoginDate,
  });

function OutcomeLine(props: { readonly outcome: SignInOutcome }) {
  const tone =
    props.outcome.status === "signed-in"
      ? "text-success-foreground"
      : props.outcome.status === "failed"
        ? "text-danger-foreground"
        : "text-foreground-muted";
  return (
    <Text accessibilityRole="alert" className={`text-sm ${tone}`}>
      {signInOutcomeText(props.outcome)}
    </Text>
  );
}

/** One step: where the walk is, what to sign in to, the existing sign-in, then Skip and Next. */
function StepFrame(props: {
  readonly entry: DetectedManualStepEntry;
  readonly position: number;
  readonly total: number;
  readonly last: boolean;
  /** What Next records; null until the step has an answer. */
  readonly outcome: SignInOutcome | null;
  readonly onResolve: (outcome: SignInOutcome) => void;
  readonly children: ReactNode;
}) {
  const text = stepText(props.entry);
  const { outcome } = props;
  return (
    <>
      <View className="gap-1 px-2">
        <Text className="text-sm text-foreground-muted">
          {props.entry.step.machine} · {signInPositionText(props.position, props.total)}
        </Text>
        <Text className="text-xl font-t3-medium text-foreground">{text.step}</Text>
        <Text className="text-sm text-foreground-muted">{text.detail}</Text>
      </View>
      {props.children}
      {outcome ? (
        <View className="px-2">
          <OutcomeLine outcome={outcome} />
        </View>
      ) : null}
      <View className="flex-row gap-3">
        <Button
          label={t("Skip")}
          onPress={() => props.onResolve({ status: "skipped", reason: "user" })}
        />
        <Button
          label={props.last ? t("Finish") : t("Next")}
          tone="primary"
          disabled={outcome === null}
          onPress={() => outcome && props.onResolve(outcome)}
        />
      </View>
    </>
  );
}

interface StepProps {
  readonly entry: DetectedManualStepEntry;
  readonly position: number;
  readonly total: number;
  readonly last: boolean;
  readonly onResolve: (outcome: SignInOutcome) => void;
}

/** The Providers screen's own account control, for one account. */
function ProviderStep(props: StepProps) {
  const { environmentId, step } = props.entry;
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const provider = providersByEnvironment
    .get(environmentId)
    ?.find((candidate) => candidate.instanceId === step.instanceId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId: step.instanceId } }),
  );
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const auth = query.data ?? undefined;
  // The flow the account had when the step began; only a later one answers for this step.
  const [baseline, setBaseline] = useState<{ readonly flowId: string | null } | null>(null);
  if (baseline === null && auth !== undefined) setBaseline({ flowId: auth.flowId });

  // Leaving the step (Skip, Next or backing out) ends the sign-in the server still runs for it.
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying"
      ? auth.flowId
      : null;
  const activeFlow = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the id of the running server flow where the unmount cleanup below can read it
  useEffect(() => {
    activeFlow.current = active;
  }, [active]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the server's sign-in flow when the step is left
  useEffect(
    () => () => {
      if (activeFlow.current !== null) {
        void cancel({
          environmentId,
          input: { instanceId: step.instanceId, flowId: activeFlow.current },
        });
      }
    },
    [cancel, environmentId, step.instanceId],
  );

  const unsupported =
    provider !== undefined && (!canManage || providerSignInUnsupportedOnPhone(provider));
  const progress: SignInProgress =
    provider === undefined
      ? {
          state: "failed",
          reason: "failed",
          message: t("This account is not available any more."),
        }
      : baseline === null
        ? { state: "pending" }
        : providerSignInProgress({
            kind: step.kind,
            baselineFlowId: baseline.flowId,
            signedIn: providerReadsSignedIn(provider, auth?.phase),
            flow: auth,
          });
  const outcome: SignInOutcome | null = unsupported
    ? { status: "skipped", reason: "unsupported" }
    : outcomeOfProgress(progress);
  return (
    <StepFrame {...props} outcome={outcome}>
      {provider === undefined ? null : unsupported ? (
        <Text className="px-2 text-base text-foreground">
          {canManage
            ? t(
                "This account has no sign-in the phone can run. Finish it on web or desktop; Next continues.",
              )
            : t("This session cannot change {machine}'s providers. Next continues.", {
                machine: step.machine,
              })}
        </Text>
      ) : (
        <>
          <SettingsSection>
            <ProviderAccount
              environment={{ environmentId, label: step.machine }}
              provider={provider}
              divider={false}
            />
          </SettingsSection>
          {auth?.interaction?.type === "terminal" ? (
            <Text className="px-2 text-sm text-foreground-muted">
              {t(
                "This sign-in runs in a terminal. If it does not respond here, skip it and finish it on web or desktop.",
              )}
            </Text>
          ) : null}
        </>
      )}
    </StepFrame>
  );
}

function McpStep(props: StepProps) {
  const { serverName } = props.entry.step;
  // The server names every MCP step it reports; one without a name cannot be signed in.
  return serverName === undefined ? (
    <StepFrame {...props} outcome={{ status: "skipped", reason: "unsupported" }}>
      <Text className="px-2 text-base text-foreground">{t("This server has no name.")}</Text>
    </StepFrame>
  ) : (
    <McpStepFlow {...props} serverName={serverName} />
  );
}

function McpStepFlow(props: StepProps & { readonly serverName: ProviderMcpServerName }) {
  const { environmentId, step } = props.entry;
  const signIn = useEnvironmentQuery(
    serverEnvironment.providerMcpSignIn({
      environmentId,
      input: { instanceId: step.instanceId, name: props.serverName },
    }),
  );
  const outcome = outcomeOfProgress(
    mcpSignInProgress({ phase: signIn.data?.phase, error: signIn.error }),
  );
  const account = detectedManualStepAccountLabel(
    step,
    providerClients.get(step.driver)?.label ?? step.driver,
  );
  return (
    <StepFrame {...props} outcome={outcome}>
      <McpSignInBody
        embedded
        environmentId={environmentId}
        instanceId={step.instanceId}
        name={props.serverName}
        providerLabel={account}
        onDone={() => undefined}
      />
    </StepFrame>
  );
}

function Summary(props: { readonly session: SignInSession; readonly onDone: () => void }) {
  const { signedIn, pending } = summarizeSignIns(props.session);
  return (
    <>
      <View className="gap-1 px-2">
        <Text className="text-xl font-t3-medium text-foreground">{t("Sign-ins finished")}</Text>
        <Text className="text-sm text-foreground-muted">
          {pending.length === 0
            ? t("Every sign-in is done.")
            : signInPendingCountText(pending.length)}
        </Text>
      </View>
      <SettingsSection>
        {[
          ...signedIn.map((step) => ({
            step,
            outcome: { status: "signed-in" } as SignInOutcome,
          })),
          ...pending,
        ].map(({ step, outcome }) => (
          <View key={step.key} className="gap-0.5 px-4 py-3">
            <Text className="text-base text-foreground">{stepText(step.entry).step}</Text>
            <OutcomeLine outcome={outcome} />
          </View>
        ))}
      </SettingsSection>
      <Button label={t("Done")} tone="primary" onPress={props.onDone} />
    </>
  );
}

/**
 * Walks one machine's detected sign-ins in the list's order, each in the screen that already
 * signs it in. It walks the steps it was opened with, so a refresh that clears one mid-walk does
 * not shift the rest. Leaving ends only the step in progress.
 */
export function SettingsSignInAllRouteScreen({ route }: Props) {
  const { machine } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { state } = useManualSteps();
  const [session, setSession] = useState<SignInSession | null>(null);
  const group =
    state?.view.status === "listed"
      ? state.view.groups.find((candidate) => candidate.machine === machine)
      : undefined;
  if (session === null && group !== undefined && group.detected.length > 0) {
    setSession(startSignInSession(group.detected));
  }
  const current = session ? currentSignIn(session) : null;
  const StepComponent = current?.step.entry.step.kind === "mcp-needs-auth" ? McpStep : ProviderStep;
  return (
    <SettingsScreen title={t("Sign in to all")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {session === null ? (
          <>
            <Text className="px-2 text-base text-foreground-muted">
              {state === null || state.view.status === "loading"
                ? t("Loading sign-ins…")
                : t("Nothing to sign in to on {machine}.", { machine })}
            </Text>
            <Button label={t("Done")} onPress={() => navigation.goBack()} />
          </>
        ) : current ? (
          <StepComponent
            key={current.step.key}
            entry={current.step.entry}
            position={current.position}
            total={current.total}
            last={current.last}
            onResolve={(outcome) =>
              setSession((previous) =>
                previous ? recordSignInOutcome(previous, current.step.key, outcome) : previous,
              )
            }
          />
        ) : (
          <Summary session={session} onDone={() => navigation.goBack()} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
