import {
  ProviderDriverKind,
  ProviderSetupError,
  TextGenerationError,
  type CodexSettings,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  CHATGPT_SHARING_SCOPE,
  codexSharingWorkspaceId,
  type CodexChatGptCredentials,
} from "../CodexChatGptAuth.ts";
import { chatGptModelsFromCatalog } from "../CodexChatGptModels.ts";
import { CHATGPT_TOKEN_REVOKED_DETAIL, isChatGptTokenRevoked } from "../CodexLoginRejected.ts";
import { makeCodexManagedRuntime } from "../CodexManagedRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { createCodexAdapterV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  makeCodexSetSkillEnabled,
  CODEX_MANAGED_UPDATE_REQUIRED_MESSAGE,
  checkCodexProviderStatus,
  codexPlanFunding,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  readCodexStoredChatGptLogin,
  resolveOwnedCodexMaintenance,
  runCodexCli,
  sameCodexAccountEmail,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import { makeCodexConsumeResetCredit } from "../codexResetCredit.ts";
import { makeCodexShellEnvironment } from "../codexShellEnvironment.ts";
import { codexAccountLimitsHomePath, makeCodexLimitsLogin } from "../CodexLimitsLogin.ts";
import { chatGptSharingLimitReading } from "../codexUsageLimits.ts";
import * as ServerConfig from "../../config.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { makeCodexMcpManagement } from "../CodexMcp.ts";
import { makeCodexPluginManagement } from "../CodexPlugins.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { usageAccountKey } from "@t3tools/provider-core/server/usageLimits";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { codexContinuationIdentity } from "./CodexHomeLayout.ts";
import { privateMcpSignInArgs } from "../codexLaunchArgs.ts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { HttpClient } from "effect/http";
const DRIVER = ProviderDriverKind.make("codex");

const readable = (limits: ServerProviderUsageLimits | undefined) =>
  limits !== undefined && limits.unavailable === undefined && limits.windows.length > 0;

/**
 * A readable reading wins. Otherwise the account links to ChatGPT and offers the limits sign-in,
 * keeping the notice of a login that could not read.
 */
const limitsToShow = (
  workspaceId: string | undefined,
  ownLogin: ServerProviderUsageLimits | undefined,
  machineLogin: ServerProviderUsageLimits | undefined,
  chatGptUsage: ServerProviderUsageLimits,
): ServerProviderUsageLimits => {
  if (!workspaceId) return chatGptUsage;
  const accountKey = usageAccountKey(workspaceId);
  const shown = [ownLogin, machineLogin].find(
    (reading) => readable(reading) && reading?.accountKey === accountKey,
  );
  if (shown) return shown;
  const failed = ownLogin ?? machineLogin;
  return failed?.unavailable
    ? { ...failed, externalUsage: chatGptUsage.externalUsage, limitsSignIn: true }
    : chatGptUsage;
};

// A sign-in without token sharing, or one ChatGPT refused even after renewal, cannot run.
const canRun = (saved: CodexChatGptCredentials) =>
  saved.refused !== true && saved.scopes.includes(CHATGPT_SHARING_SCOPE);

export const makeManagedCodexProvider = Effect.fn("makeManagedCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const { instanceId, enabled, displayName, accentColor, config } = input;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const environment = yield* mergeProviderInstanceEnvironment(input.environment);
  const runtime = yield* makeCodexManagedRuntime({ instanceId, enabled, config, environment });
  // The limits login is a plain Codex login, so no ambient override may redirect it.
  const limitsEnvironment: NodeJS.ProcessEnv = { ...environment };
  delete limitsEnvironment.ACCESS_TOKEN;
  delete limitsEnvironment.T3CODE_CODEX_LAUNCH_ARGS;
  delete limitsEnvironment.OPENAI_API_KEY;
  delete limitsEnvironment.OPENAI_BASE_URL;
  const limits = yield* makeCodexLimitsLogin({
    instanceId,
    home: codexAccountLimitsHomePath(path, stateDir, instanceId),
    binaryPath: runtime.installation.resolve().pipe(
      Effect.map((codex) => codex.executablePath),
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId,
            operation: "install",
            detail: "Set up managed Codex before reading its limits.",
            cause,
          }),
      ),
    ),
    environment: limitsEnvironment,
    account: runtime.auth.read.pipe(
      Effect.map((saved) =>
        Option.isSome(saved)
          ? { email: saved.value.email, workspaceId: codexSharingWorkspaceId(saved.value) }
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    ),
  });
  const continuationIdentity = codexContinuationIdentity(runtime.homeLayout);
  const stamp = withInstanceIdentity({
    instanceId,
    driverKind: DRIVER,
    displayName,
    accentColor,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const setup = { canAuthenticate: true, canInstall: true };
  const runtimePaths = {
    homePath: runtime.homeLayout.sharedHomePath,
    shadowHomePath: runtime.homeLayout.mode === "authOverlay" ? runtime.homePath : null,
  };
  const pending = makePendingCodexProvider({ ...config, enabled, customModels: [] }).pipe(
    Effect.map((draft) =>
      stamp({
        ...draft,
        models: [],
        setup,
        runtimePaths,
      }),
    ),
  );
  const check = Effect.gen(function* () {
    const base = yield* pending;
    if (!enabled) return base;
    const executable = yield* runtime.installation.resolve().pipe(Effect.option);
    if (Option.isNone(executable)) {
      const version = yield* runtime.installation.installedManagedVersion;
      return {
        ...base,
        installed: version !== null,
        version,
        status: version === null ? base.status : ("error" as const),
        models: [],
        message:
          version === null ? "Set up Codex to get started." : CODEX_MANAGED_UPDATE_REQUIRED_MESSAGE,
        auth: { status: "unauthenticated" as const },
      };
    }
    const saved = yield* runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(saved) && !saved.value.scopes.includes(CHATGPT_SHARING_SCOPE))
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        models: [],
        message:
          "Signed in with ChatGPT, but token sharing is disabled. Sign in again and enable token sharing, or use another provider.",
        auth: {
          status: "unauthenticated" as const,
          label: "ChatGPT",
          ...(saved.value.email?.trim() ? { email: saved.value.email.trim() } : {}),
        },
      };
    if (Option.isNone(saved))
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        models: [],
        message: "Sign in with ChatGPT to use Codex.",
        auth: { status: "unauthenticated" as const },
      };
    // Shown when no Codex login of this account can read its limits on this machine.
    const chatGptUsageLimits = {
      checkedAt: base.checkedAt,
      windows: [],
      unavailable: {
        reason: "unsupported" as const,
        message:
          "ChatGPT tracks subscription usage across connected apps. Open Usage settings with the account you connected to Codex.",
      },
      externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      limitsSignIn: true,
    } satisfies ServerProviderUsageLimits;
    const workspaceId = codexSharingWorkspaceId(saved.value);
    const managedAuth = {
      subscriptionSharing: true,
      profileId: saved.value.clientId,
      status: "authenticated" as const,
      type: "chatgpt",
      funding: "unknown" as const,
      ...(workspaceId ? { workspaceId, fundingScope: "workspace" as const } : {}),
      label: "ChatGPT",
      ...(saved.value.email?.trim() ? { email: saved.value.email.trim() } : {}),
    };
    return yield* runtime.auth.controller.withAccess!(runtime.resolve).pipe(
      Effect.flatMap((effective) =>
        Effect.gen(function* () {
          const draft = yield* checkCodexProviderStatus(
            effective.config,
            undefined,
            effective.environment,
            managedAuth,
          );
          const connectionChanged = () =>
            new ProviderSetupError({
              instanceId,
              operation: "models",
              detail: "The ChatGPT connection changed while checking Codex. Retry.",
            });
          const models = yield* chatGptModelsFromCatalog(effective.catalog, draft.models);
          const ownLimits = yield* limits.read;
          // The sign-in can change during discovery, including while the limits read is in flight.
          const current = Option.filter(yield* runtime.auth.read, canRun);
          if (
            Option.isNone(current) ||
            (yield* runtime.auth.profileKey(current.value)) !== effective.revision ||
            (yield* runtime.auth.profileKey(saved.value)) !== effective.revision
          )
            return yield* connectionChanged();
          return [
            { ...draft, models, version: draft.version ?? effective.version },
            ownLimits,
          ] as const;
        }),
      ),
      Effect.map(([draft, ownLimits]) => {
        const usageLimits = limitsToShow(
          workspaceId,
          ownLimits,
          draft.usageLimits,
          chatGptUsageLimits,
        );
        return stamp({
          ...draft,
          auth: {
            ...managedAuth,
            funding: codexPlanFunding(usageLimits.plan),
          },
          usageLimits,
          models: draft.models.map((model) => ({
            ...model,
            ...(model.capabilities
              ? {
                  capabilities: {
                    ...model.capabilities,
                    optionDescriptors: (model.capabilities.optionDescriptors ?? []).filter(
                      (option) => option.id !== "serviceTier",
                    ),
                  },
                }
              : {}),
          })),
          setup,
          runtimePaths,
          ...(draft.slashCommands
            ? {
                slashCommands: draft.slashCommands.filter((command) => command.name !== "feedback"),
              }
            : {}),
        });
      }),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const ownLimits = yield* limits.read;
          // The sign-in saved after the slow limits probe, not the failed attempt, decides: it may
          // have replaced the refused one, or ChatGPT may have refused it meanwhile.
          const current = yield* runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none()));
          const connected = Option.filter(current, canRun);
          const workspaceId = Option.isSome(connected)
            ? codexSharingWorkspaceId(connected.value)
            : undefined;
          const refused = Option.exists(current, (saved) => saved.refused === true);
          return {
            ...base,
            installed: true,
            version: executable.value.version,
            models: [],
            auth: {
              status: Option.isSome(connected)
                ? ("authenticated" as const)
                : ("unauthenticated" as const),
              label: "ChatGPT",
              ...(workspaceId ? { workspaceId } : {}),
              ...(Option.isSome(connected)
                ? { subscriptionSharing: true, profileId: connected.value.clientId }
                : {}),
              ...(Option.isSome(current) && current.value.email?.trim()
                ? { email: current.value.email.trim() }
                : {}),
            },
            ...(Option.isSome(connected)
              ? { usageLimits: limitsToShow(workspaceId, ownLimits, undefined, chatGptUsageLimits) }
              : {}),
            message:
              Option.isNone(connected) && (refused || isChatGptTokenRevoked(error))
                ? CHATGPT_TOKEN_REVOKED_DETAIL
                : "Could not check Codex right now. Retry, or reconnect in provider settings.",
          };
        }),
      ),
      Effect.scoped,
    );
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  const snapshotSettings = yield* makeProviderSnapshotSettingsSource(config);
  const resolveMaintenance = () => resolveOwnedCodexMaintenance(runtime.installation);
  const snapshot = yield* makeManagedServerProvider({
    readsUsageOnRefresh: true,
    resolveMaintenance,
    getSettings: snapshotSettings.getSettings,
    streamSettings: snapshotSettings.streamSettings,
    haveSettingsChanged: haveProviderSnapshotSettingsChanged,
    initialSnapshot: () => pending,
    checkProvider: check,
    enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
      resolveMaintenance().pipe(
        Effect.flatMap((maintenance) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenance, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        Effect.flatMap(publishSnapshot),
      ),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Could not prepare managed Codex.",
          cause,
        }),
    ),
  );
  yield* runtime.auth.controller.subscribe("managed-codex-snapshot").pipe(
    Stream.filter((state) => ["idle", "succeeded", "failed", "cancelled"].includes(state.phase)),
    // ChatGPT can refuse a renewal mid-session; publish that sign-out without waiting for a check.
    Stream.merge(runtime.auth.signedOut),
    // Sign-out interrupts in-flight probes; keep listening for its subsequent idle refresh.
    Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkScoped,
  );
  // `subscribe` replays the current idle state first; only a later sign-in or sign-out re-reads.
  yield* limits.controller.subscribe("codex-limits-snapshot").pipe(
    Stream.drop(1),
    Stream.filter((state) => state.phase === "succeeded" || state.phase === "idle"),
    Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkScoped,
  );
  const resolveRuntime = runtime.auth.controller.withAccess!(runtime.resolve);
  const openAppServerClient = resolveRuntime.pipe(
    Effect.flatMap((effective) =>
      withCodexAppServerClient({
        binaryPath: effective.config.binaryPath,
        homePath: effective.config.homePath,
        launchArgs: effective.config.launchArgs,
        cwd: process.cwd(),
        environment: effective.environment,
      }),
    ),
    Effect.map(({ client }) => client),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  // Either Codex login can hold another workspace belonging to the same person.
  const checkResetAccount = Effect.fn("CodexManagedProvider.checkResetAccount")(
    function* (home: string, accountId: string | null | undefined) {
      const saved = yield* runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none()));
      const login = yield* readCodexStoredChatGptLogin(home);
      if (
        !login ||
        login.accountId !== accountId?.trim() ||
        !Option.exists(
          saved,
          (current) =>
            canRun(current) &&
            sameCodexAccountEmail(login.email, current.email) &&
            codexSharingWorkspaceId(current) === login.accountId,
        )
      )
        return yield* new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail:
            "The Codex login could not confirm this workspace, so its reset credit was not used.",
        });
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  const accountHome = runtime.homeLayout.effectiveHomePath ?? runtime.homeLayout.sharedHomePath;
  const consumeThroughOwnHome = makeCodexConsumeResetCredit({
    instanceId,
    accountHome,
    coordinator: resetCreditCoordinator,
    openClient: openAppServerClient,
    checkAccount: (id) => checkResetAccount(accountHome, id),
    snapshot,
  });
  const consumeThroughLimitsLogin = makeCodexConsumeResetCredit({
    instanceId,
    accountHome: limits.home,
    coordinator: resetCreditCoordinator,
    openClient: limits.openClient,
    checkAccount: (id) => checkResetAccount(limits.home, id),
    snapshot,
  });
  const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = (request) =>
    limits.signedIn.pipe(
      Effect.flatMap((present) =>
        present ? consumeThroughLimitsLogin(request) : consumeThroughOwnHome(request),
      ),
    );
  const removeLimitsLogin = limits.controller
    .logout(Effect.void)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove the Codex limits sign-in.", { cause }),
      ),
    );
  const plugins = yield* makeCodexPluginManagement({ instanceId, openClient: openAppServerClient });
  const mcp = yield* makeCodexMcpManagement({
    instanceId,
    openClient: openAppServerClient,
    runCli: (args) =>
      resolveRuntime.pipe(
        Effect.flatMap((effective) =>
          runCodexCli(
            {
              binaryPath: effective.config.binaryPath,
              homePath: effective.config.homePath,
              cwd: process.cwd(),
              environment: effective.environment,
            },
            [...privateMcpSignInArgs(effective.privateMcpSignIns), ...args],
          ),
        ),
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  // Launch settings bind the refresh command to the signed-in profile. The registry
  // already wraps openSession in withAccess, so resolve without re-entering it.
  const models = snapshot.getSnapshot.pipe(Effect.map((value) => value.models));
  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    bindUsageLimits: Effect.suspend(() => snapshot.bindUsageLimits),
    // The check renews a rejected token once and signs the account out when ChatGPT refuses.
    onAuthenticationFailed: snapshot.refresh.pipe(Effect.ignoreCause({ log: true })),
    readSignedOut: runtime.auth.read.pipe(
      Effect.map((saved) => !Option.exists(saved, canRun)),
      // An unreadable store is no evidence of a sign-out.
      Effect.catch((cause) =>
        Effect.logError("Could not read the ChatGPT sign-in.", { cause }).pipe(Effect.as(false)),
      ),
    ),
    models,
    resolveRuntime: runtime.resolve,
    // Reading now also shows the stop on the Limits bar.
    chatGptSharingLimitReading: snapshot.refresh.pipe(
      Effect.timeoutOption("30 seconds"),
      Effect.flatMap((refreshed) =>
        Effect.map(DateTime.now, (now) =>
          Option.isSome(refreshed)
            ? chatGptSharingLimitReading(refreshed.value.usageLimits, DateTime.toEpochMillis(now))
            : null,
        ),
      ),
    ),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Failed to build Codex orchestration adapter.",
          cause,
        }),
    ),
  );
  const nativeGeneration = yield* makeCodexTextGeneration(
    config,
    undefined,
    models,
    resolveRuntime,
  );
  const isTextGenerationError = Schema.is(TextGenerationError);
  const protect = <A>(operation: string, effect: Effect.Effect<A, TextGenerationError>) =>
    runtime.auth.controller.withAccess!(effect).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "detail" in cause ? cause.detail : "Codex text generation failed.",
              ...("retryable" in cause && cause.retryable !== undefined
                ? { retryable: cause.retryable }
                : {}),
              cause,
            }),
      ),
    );
  const textGeneration: ProviderInstance["textGeneration"] = {
    ...(nativeGeneration.supportsInvestigation ? { supportsInvestigation: true } : {}),
    generateCommitMessage: (value) =>
      protect("generateCommitMessage", nativeGeneration.generateCommitMessage(value)),
    generatePrContent: (value) =>
      protect("generatePrContent", nativeGeneration.generatePrContent(value)),
    generateBranchName: (value) =>
      protect("generateBranchName", nativeGeneration.generateBranchName(value)),
    generateThreadTitle: (value) =>
      protect("generateThreadTitle", nativeGeneration.generateThreadTitle(value)),
    generateReviewGuide: (value) =>
      protect("generateReviewGuide", nativeGeneration.generateReviewGuide(value)),
    generateManualStepReview: (value) =>
      protect("generateManualStepReview", nativeGeneration.generateManualStepReview(value)),
    generateTranscriptionPostProcessing: (value) =>
      protect(
        "generateTranscriptionPostProcessing",
        nativeGeneration.generateTranscriptionPostProcessing(value),
      ),
  };
  return {
    instanceId,
    driverKind: DRIVER,
    continuationIdentity,
    displayName,
    accentColor,
    enabled,
    snapshot,
    consumeResetCredit,
    fundingForWorkspace: ({ provider }) =>
      runtime.auth.access.pipe(
        Effect.map((current) => {
          const workspaceId = codexSharingWorkspaceId(current);
          const funding = codexPlanFunding(provider.usageLimits?.plan);
          return canRun(current) &&
            current.clientId === provider.auth.profileId &&
            sameCodexAccountEmail(current.email, provider.auth.email) &&
            workspaceId &&
            workspaceId === provider.auth.workspaceId &&
            provider.usageLimits?.accountKey === usageAccountKey(workspaceId) &&
            provider.auth.funding === funding
            ? funding
            : ("unknown" as const);
        }),
        Effect.orElseSucceed(() => "unknown" as const),
      ),
    orchestrationAdapter,
    textGeneration,
    // Disconnecting the account also removes the login kept for its limits.
    auth: {
      ...runtime.auth.controller,
      logout: (stopSessions) =>
        runtime.auth.controller.logout(stopSessions).pipe(Effect.tap(() => removeLimitsLogin)),
    },
    limitsAuth: limits.controller,
    plugins,
    // The account's shadow home links its skills folder here, which may not exist yet.
    personalSkillsDirectory: path.join(runtime.homeLayout.sharedHomePath, "skills"),
    setSkillEnabled: makeCodexSetSkillEnabled({ instanceId, openClient: openAppServerClient }),
    mcp,
    shellEnvironment: makeCodexShellEnvironment({
      instanceId,
      environment: input.environment,
      openClient: openAppServerClient,
    }),
    snapshotForCwd: (cwd: string) =>
      enabled
        ? resolveRuntime.pipe(
            Effect.matchEffect({
              // Signed-out snapshots have an empty inventory; a signed-in runtime failure must fail the scan.
              onFailure: (cause) =>
                snapshot.getSnapshot.pipe(
                  Effect.filterOrFail(
                    (machine) => machine.auth.status === "unauthenticated",
                    () => cause,
                  ),
                ),
              onSuccess: (effective) =>
                probeCodexSkillsForCwd({
                  binaryPath: effective.config.binaryPath,
                  homePath: effective.config.homePath,
                  launchArgs: effective.config.launchArgs,
                  cwd,
                  environment: effective.environment,
                }).pipe(
                  Effect.flatMap((skills) =>
                    snapshot.getSnapshot.pipe(Effect.map((draft) => ({ ...draft, skills }))),
                  ),
                ),
            }),
            Effect.scoped,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            // Fail instead of returning machine inventory, which the registry would publish as workspace inventory.
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER,
                  instanceId,
                  detail: `Failed to probe Codex skills for '${cwd}'`,
                  cause,
                }),
            ),
          )
        : snapshot.getSnapshot,
  } satisfies ProviderInstance;
});
