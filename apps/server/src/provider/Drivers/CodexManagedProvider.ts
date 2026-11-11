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
import { ChildProcessSpawner } from "effect/process";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { chatGptModels, withChatGptToken } from "../CodexChatGptModels.ts";
import { makeCodexManagedRuntime } from "../CodexManagedRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { createCodexAdapterV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  readCodexStoredChatGptLogin,
  runCodexCli,
  sameCodexAccountEmail,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import { makeCodexConsumeResetCredit } from "../codexResetCredit.ts";
import { codexAccountLimitsHomePath, makeCodexLimitsLogin } from "../CodexLimitsLogin.ts";
import { chatGptSharingLimitReading } from "../codexUsageLimits.ts";
import * as ServerConfig from "../../config.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { makeCodexMcpManagement } from "../CodexMcp.ts";
import { makeCodexPluginManagement } from "../CodexPlugins.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
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
  ownLogin: ServerProviderUsageLimits | undefined,
  machineLogin: ServerProviderUsageLimits | undefined,
  chatGptUsage: ServerProviderUsageLimits,
): ServerProviderUsageLimits => {
  const shown = [ownLogin, machineLogin].find(readable);
  if (shown) return shown;
  const failed = ownLogin ?? machineLogin;
  return failed?.unavailable
    ? { ...failed, externalUsage: chatGptUsage.externalUsage, limitsSignIn: true }
    : chatGptUsage;
};

export const makeManagedCodexProvider = Effect.fn("makeManagedCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const { instanceId, enabled, displayName, accentColor, config } = input;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
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
    accountEmail: runtime.auth.read.pipe(
      Effect.map((saved) => (Option.isSome(saved) ? saved.value.email?.trim() : undefined)),
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
    if (Option.isNone(executable))
      return {
        ...base,
        installed: false,
        models: [],
        message: "Set up Codex to get started.",
        auth: { status: "unauthenticated" as const },
      };
    const saved = yield* runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(saved) && !saved.value.scopes.includes("chatgpt.tokens.use.direct"))
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
    const managedAuth = {
      subscriptionSharing: true,
      profileId: saved.value.clientId,
      status: "authenticated" as const,
      type: "chatgpt",
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
          const credentials = yield* runtime.auth.access;
          // Another server can replace the saved profile while the native probe runs.
          // Never send that account's token with the launch profile's catalog labels.
          if (
            (yield* runtime.auth.profileKey(credentials)) !== effective.revision ||
            (yield* runtime.auth.profileKey(saved.value)) !== effective.revision
          )
            return yield* new ProviderSetupError({
              instanceId,
              operation: "models",
              detail: "The ChatGPT connection changed while checking Codex. Retry.",
            });
          const { value: models } = yield* withChatGptToken(
            runtime.auth,
            instanceId,
            credentials,
            (accessToken) =>
              chatGptModels(accessToken, draft.models).pipe(
                Effect.provideService(HttpClient.HttpClient, http),
              ),
          );
          return { ...draft, models };
        }),
      ),
      Effect.zip(limits.read),
      Effect.map(([draft, ownLimits]) =>
        stamp({
          ...draft,
          auth: managedAuth,
          version: draft.version ?? executable.value.version,
          usageLimits: limitsToShow(ownLimits, draft.usageLimits, chatGptUsageLimits),
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
        }),
      ),
      Effect.catch(() =>
        Effect.all([
          runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none())),
          limits.read,
        ]).pipe(
          Effect.map(([current, ownLimits]) => ({
            ...base,
            installed: true,
            version: executable.value.version,
            models: [],
            auth: {
              status:
                Option.isSome(current) && current.value.scopes.includes("chatgpt.tokens.use.direct")
                  ? ("authenticated" as const)
                  : ("unauthenticated" as const),
              label: "ChatGPT",
              ...(Option.isSome(current) &&
              current.value.scopes.includes("chatgpt.tokens.use.direct")
                ? { subscriptionSharing: true, profileId: current.value.clientId }
                : {}),
              ...(Option.isSome(current) && current.value.email?.trim()
                ? { email: current.value.email.trim() }
                : {}),
            },
            ...(Option.isSome(current) && current.value.scopes.includes("chatgpt.tokens.use.direct")
              ? { usageLimits: limitsToShow(ownLimits, undefined, chatGptUsageLimits) }
              : {}),
            message: "Could not check Codex right now. Retry, or reconnect in provider settings.",
          })),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
    getSettings: host.settings.get,
    streamSettings: host.settings.changes,
    haveSettingsChanged: () => false,
    initialSnapshot: () => pending,
    checkProvider: check,
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
  // Limits come from the home's own Codex login, so its credits are spent through it, but only
  // while it is still signed in as this account. A sharing launch reports no account, so the
  // saved login names it.
  const accountHome = runtime.homeLayout.effectiveHomePath ?? runtime.homeLayout.sharedHomePath;
  const consumeThroughOwnHome = makeCodexConsumeResetCredit({
    instanceId,
    accountHome,
    coordinator: resetCreditCoordinator,
    openClient: openAppServerClient,
    checkAccount: Effect.gen(function* () {
      const saved = yield* runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none()));
      const login = yield* readCodexStoredChatGptLogin(accountHome);
      if (Option.isNone(saved) || !sameCodexAccountEmail(login?.email, saved.value.email))
        return yield* new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail:
            "This machine's Codex login is no longer this account, so its reset credits can't be used here.",
        });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    ),
    snapshot,
  });
  const consumeThroughLimitsLogin = makeCodexConsumeResetCredit({
    instanceId,
    accountHome: limits.home,
    coordinator: resetCreditCoordinator,
    openClient: limits.openClient,
    snapshot,
  });
  const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
    limits.signedIn.pipe(
      Effect.flatMap((present) =>
        present ? consumeThroughLimitsLogin() : consumeThroughOwnHome(),
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
  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    onUsageLimits: (update) => snapshot.applyUsageLimits(update),
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
    snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    resolveRuntime,
  );
  const protect = <A>(operation: string, effect: Effect.Effect<A, TextGenerationError>) =>
    runtime.auth.controller.withAccess!(effect).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "detail" in cause ? cause.detail : "Codex text generation failed.",
          }),
      ),
    );
  const textGeneration: ProviderInstance["textGeneration"] = {
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
    mcp,
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
