import { getFormattingLocale, t } from "../../lib/i18n";
import { providerLoginExpiryText } from "@t3tools/client-runtime/providerLoginExpiryText";
import { providerAuthMethodText } from "@t3tools/client-runtime/providerAuthMethodText";
import { providerLoginExpiry } from "@t3tools/shared/providerLoginExpiry";
import * as Dialog from "../../components/ui/Dialog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  isManagedDriverAllowed,
  type ProviderAuthResponse,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { Linking, Pressable, ScrollView, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { MenuAction } from "@react-native-menu/menu";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironments } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsProviderAccountsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const permittedEnvironments = useEnvironmentsWithScope(selectedTargets, AuthProvidersManageScope);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const { environments } = useEnvironments();
  const insets = useSafeAreaInsets();
  // The machine an account arrived from through shared settings, or null when this app does not know it.
  const sharedFrom = (target: SettingsTarget, provider: ServerProvider) => {
    const origin = target.serverConfig.settings.providerInstances[provider.instanceId]?.sharedFrom;
    return origin === undefined
      ? undefined
      : (environments.find((environment) => environment.environmentId === origin)?.label ?? null);
  };
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title={t("Providers")} trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">{t("Select a connected environment.")}</Text>
          ) : (
            selectedTargets.map((environment) => (
              <SettingsSection key={environment.environmentId} title={environment.label}>
                {!permittedEnvironments.has(environment.environmentId) ? (
                  <View className="gap-1 p-4">
                    <Text className="text-base text-foreground">{t("Limited permissions")}</Text>
                    <Text className="text-sm text-foreground-muted">
                      {t(
                        "This session can view {environment}'s providers but can't change their settings.",
                        { environment: environment.label },
                      )}
                    </Text>
                  </View>
                ) : (
                  <>
                    {managedProviders(environment, providersByEnvironment)
                      .filter(canManageProvider)
                      .map((provider, index) => (
                        <ProviderAccount
                          key={provider.instanceId}
                          environment={environment}
                          provider={provider}
                          sharedFrom={sharedFrom(environment, provider)}
                          divider={index > 0}
                        />
                      ))}
                    {!managedProviders(environment, providersByEnvironment).some(
                      canManageProvider,
                    ) ? (
                      <Text className="p-4 text-foreground-muted">
                        {t("Configure a provider with in-app sign-in in web or desktop Settings.")}
                      </Text>
                    ) : null}
                  </>
                )}
              </SettingsSection>
            ))
          )}
          {selectedTargets.length > 0 ? (
            <SettingsSection>
              <SettingsRow
                icon="sparkles"
                label={t("Capabilities")}
                value={t("MCP servers and skills")}
                target="SettingsCapabilities"
              />
            </SettingsSection>
          ) : null}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/** Providers the environment's managed policy allows; the rest cannot run or sign in. */
function managedProviders(
  environment: SettingsTarget,
  providersByEnvironment: ReadonlyMap<string, ReadonlyArray<ServerProvider>>,
) {
  return (providersByEnvironment.get(environment.environmentId) ?? []).filter((provider) =>
    isManagedDriverAllowed(environment.serverConfig.managedPolicy, provider.driver),
  );
}

function canManageProvider(provider: ServerProvider) {
  return Boolean(
    provider.setup?.canAuthenticate || (provider.driver === "acpRegistry" && provider.installed),
  );
}

const formatLoginDate = (iso: string) =>
  new Intl.DateTimeFormat(getFormattingLocale(), { dateStyle: "medium" }).format(new Date(iso));

/** One provider account's sign-in: its status, the sign-in controls, and the flow's own steps. */
export function ProviderAccount({
  environment,
  provider,
  sharedFrom,
  divider,
}: {
  readonly environment: Pick<SettingsTarget, "environmentId" | "label">;
  readonly provider: ServerProvider;
  /** The machine the account arrived from through shared settings; null when it is not known. */
  readonly sharedFrom?: string | null | undefined;
  readonly divider: boolean;
}) {
  const nowMs = useNowMinuteMs();
  const environmentId = environment.environmentId;
  const instanceId = provider.instanceId;
  const target = { environmentId, input: { instanceId } };
  const auth = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, options);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  // Matches ListRowLayout: large text stacks the action below instead of squeezing the status.
  const stacked = useWindowDimensions().fontScale >= 1.5;
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const state = auth.data;
  const interaction = state?.interaction;
  const draftId = `${state?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const active =
    state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
  // Another provider may already own this account; it then needs its own sign-in.
  const unavailableReason =
    provider.availability === "unavailable" ? provider.unavailableReason : undefined;
  const signedIn =
    unavailableReason === undefined &&
    (provider.auth.status === "authenticated" ||
      (provider.auth.status === "unknown" && state?.phase === "succeeded"));
  const isDiscovering =
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !auth.error &&
    state?.methods === undefined;
  const needsExternalSetup =
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && state?.methods?.length === 0));
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : state?.authorizationUrl;
  const disabled = pending || auth.error !== null || isDiscovering;
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await command();
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : t("Could not update provider sign-in."),
      );
    }
    return false;
  }
  function send(response: ProviderAuthResponse) {
    if (!state?.flowId || !interaction) return Promise.resolve(false);
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: state.flowId!, interactionId: interaction.id, response },
      }),
    );
  }
  function field(name: string, label: string, secret: boolean) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={label}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        maxLength={secret && interaction?.type === "terminal" ? 4_095 : 16_384}
        value={values[name] ?? ""}
        onChangeText={(value) => setDraft({ id: draftId, values: { ...values, [name]: value } })}
      />
    );
  }
  const name = provider.displayName ?? provider.driver;
  const loginExpiry = providerLoginExpiry(provider.auth.loginExpiresAt, nowMs);
  const loginText =
    loginExpiry && !active && unavailableReason === undefined && provider.enabled
      ? providerLoginExpiryText(loginExpiry, formatLoginDate)
      : null;
  const email = signedIn && !active && provider.enabled ? provider.auth.email?.trim() : undefined;
  const methods =
    state?.methods?.map((method) => providerAuthMethodText(provider.driver, method)) ?? [];
  // The status line says why a provider that is missing or turned off can't sign in.
  const canSignIn =
    !active &&
    !needsExternalSetup &&
    provider.setup?.canAuthenticate !== false &&
    provider.enabled &&
    provider.installed;
  const signInDisabled = disabled || state === null;
  const canSignOut =
    !active && signedIn && (provider.auth.canLogout ?? provider.setup?.canAuthenticate);
  const showCallback =
    Boolean(url) && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction);
  const usesCredentials =
    provider.driver === "antigravity" &&
    (provider.auth.type === "gemini-api-key" || provider.auth.type === "agent-platform");
  const status =
    active || state?.phase === "failed" || state?.phase === "cancelled"
      ? state.message
      : !provider.enabled
        ? t("Turned off")
        : signedIn
          ? (loginText?.text ?? t("Signed in"))
          : isDiscovering
            ? t("Discovering sign-in methods…")
            : needsExternalSetup
              ? t("No in-app sign-in advertised. Follow the provider's docs to finish setup.")
              : !provider.installed
                ? t("Not installed")
                : (unavailableReason ??
                  (usesCredentials ? t("Connect to load models") : t("Not signed in")));
  // A provider with several sign-in methods picks one from a menu on the same control.
  const methodActions: MenuAction[] = methods.map((method) => ({
    id: `method:${method.id}`,
    title: method.name,
    ...(method.description ? { subtitle: method.description } : {}),
  }));
  function startSignIn(methodId?: string) {
    void run(() => start(methodId ? { environmentId, input: { instanceId, methodId } } : target));
  }
  function signOut() {
    Dialog.alert(
      t("Sign out?"),
      t(
        "Running threads sharing this sign-in on {environment} will stop. Thread history is kept.",
        { environment: environment.label },
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Sign out"),
          style: "destructive",
          onPress: () => {
            void run(() => logout(target));
          },
        },
      ],
    );
  }
  function onMenuAction(id: string) {
    if (id === "signOut") signOut();
    // iOS keeps a disabled submenu's children selectable, so sign-in guards here too.
    else if (signInDisabled) return;
    else if (id.startsWith("method:")) startSignIn(id.slice("method:".length));
    else if (id === "change") startSignIn();
  }
  const accountActions: MenuAction[] = [
    ...(canSignIn
      ? [
          {
            id: "change",
            title: loginText?.actionLabel ?? t("Change account"),
            image: "person.crop.circle",
            attributes: { disabled: signInDisabled },
            ...(methodActions.length > 1
              ? {
                  subactions: methodActions.map((action) => ({
                    ...action,
                    attributes: { disabled: signInDisabled },
                  })),
                }
              : {}),
          },
        ]
      : []),
    ...(canSignOut
      ? [
          {
            id: "signOut",
            title: t("Sign out"),
            image: "rectangle.portrait.and.arrow.right",
            attributes: { destructive: true, disabled: disabled || state === null },
          },
        ]
      : []),
  ];
  const trailing = pending ? (
    <View className="h-11 w-11 items-center justify-center">
      <AppActivityIndicator colorClassName="accent-icon" />
    </View>
  ) : needsExternalSetup && provider.setup?.documentationUrl ? (
    <ControlPill
      variant="pill"
      label={t("Docs")}
      onPress={() => {
        void Linking.openURL(provider.setup!.documentationUrl!).catch(() =>
          setError(t("Could not open the provider docs.")),
        );
      }}
    />
  ) : active && state?.flowId ? (
    <ControlPill
      variant="pill"
      label={t("Cancel")}
      accessibilityLabel={t("Cancel {name} sign-in", { name })}
      disabled={disabled}
      onPress={() => {
        void run(() => cancel({ environmentId, input: { instanceId, flowId: state.flowId! } }));
      }}
    />
  ) : signedIn && !active && accountActions.length > 0 ? (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={t("{name} account options", { name })}
      title={name}
      actions={accountActions}
      onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
    >
      <ControlPill icon="ellipsis" accessibilityLabel={t("{name} account options", { name })} />
    </Menu>
  ) : canSignIn && !signedIn && methodActions.length > 1 && !signInDisabled ? (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={t("Sign in to {name}", { name })}
      title={t("Sign in with")}
      actions={methodActions}
      onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
    >
      <ControlPill
        variant="primary"
        label={t("Sign in")}
        accessibilityLabel={t("Sign in to {name}", { name })}
      />
    </Menu>
  ) : canSignIn && !signedIn ? (
    <ControlPill
      variant="primary"
      label={usesCredentials ? t("Connect") : t("Sign in")}
      accessibilityLabel={
        usesCredentials ? t("Connect to {name}", { name }) : t("Sign in to {name}", { name })
      }
      disabled={signInDisabled}
      onPress={() => startSignIn()}
    />
  ) : null;
  return (
    <View className={divider ? "border-t border-border-subtle" : undefined}>
      <View
        className={
          stacked
            ? "min-h-16 items-start gap-3 px-4 py-3"
            : "min-h-16 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <ProviderAccountSummary
          key={email}
          name={name}
          status={
            sharedFrom === undefined
              ? status
              : [
                  status,
                  sharedFrom === null ? t("Shared") : t("From {machine}", { machine: sharedFrom }),
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
          email={email}
        />
        {trailing}
      </View>
      {!active && methods.find((method) => method.id === "setup-token")?.description ? (
        <View className="px-4 pb-3">
          <Text className="text-sm text-foreground-muted">
            {methods.find((method) => method.id === "setup-token")?.description}
          </Text>
        </View>
      ) : null}
      {interaction?.type === "deviceCode" ||
      interaction?.type === "terminal" ||
      interaction?.type === "credentials" ||
      showCallback ||
      error ||
      auth.error ? (
        <View className="gap-2 px-4 pb-3">
          {interaction?.type === "deviceCode" ? (
            <Text selectable className="text-foreground">
              {t("Enter code {code} on the sign-in page.", { code: interaction.userCode })}
            </Text>
          ) : null}
          {interaction?.type === "terminal" ? (
            <>
              <ScrollView className="max-h-64" nestedScrollEnabled>
                <Text selectable className="font-mono text-sm text-foreground">
                  {interaction.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")}
                </Text>
              </ScrollView>
              {field("input", t("Terminal response"), true)}
              <SettingsActionRow
                icon="arrow.up"
                label={t("Send response")}
                disabled={disabled}
                onPress={() => {
                  void send({ type: "terminal", data: `${values.input ?? ""}\r` }).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {interaction?.type === "credentials" ? (
            <>
              {interaction.fields.map((entry) => (
                <View key={entry.name}>{field(entry.name, entry.label, entry.secret)}</View>
              ))}
              <SettingsActionRow
                icon="person.crop.circle"
                label={t("Connect")}
                disabled={disabled}
                onPress={() => {
                  void send({ type: "credentials", values }).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {showCallback ? (
            <>
              {field("callback", t("Final localhost URL"), false)}
              <SettingsActionRow
                icon="arrow.right"
                label={t("Continue")}
                disabled={disabled || !values.callback?.trim()}
                onPress={() => {
                  if (!state?.flowId) return;
                  void run(() =>
                    complete({
                      environmentId,
                      input: { instanceId, flowId: state.flowId!, callbackUrl: values.callback! },
                    }),
                  ).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {error || auth.error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error ?? auth.error}
            </Text>
          ) : null}
        </View>
      ) : null}
      {url ? (
        <SettingsActionRow
          icon="globe"
          label={t("Open sign-in page")}
          disabled={disabled}
          onPress={() => {
            void (async () => {
              if (
                interaction?.type === "browser" &&
                interaction.requiresConsent &&
                !(await send({ type: "browser", action: "accept" }))
              )
                return;
              await Linking.openURL(url);
            })().catch(() => setError(t("Could not open the sign-in page.")));
          }}
        />
      ) : null}
    </View>
  );
}

function ProviderAccountSummary({
  name,
  status,
  email,
}: {
  readonly name: string;
  readonly status: string | null | undefined;
  readonly email: string | undefined;
}) {
  const [revealed, setRevealed] = useState(false);
  const content = (
    <>
      <Text textRole="body" className="text-foreground" numberOfLines={1}>
        {name}
      </Text>
      <Text accessibilityLiveRegion="polite" textRole="footnote" className="text-foreground-muted">
        {email ? `${status} · ${revealed ? email : "••••••@••••••"}` : status}
      </Text>
    </>
  );
  if (!email) {
    return (
      <View
        accessible
        accessibilityLabel={[name, status].filter(Boolean).join(", ")}
        className="min-w-0 shrink grow gap-0.5"
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, status, revealed ? email : null].filter(Boolean).join(", ")}
      accessibilityHint={revealed ? t("Hides the account email") : t("Reveals the account email")}
      onPress={() => setRevealed((value) => !value)}
      className="min-w-0 shrink grow gap-0.5"
    >
      {content}
    </Pressable>
  );
}
