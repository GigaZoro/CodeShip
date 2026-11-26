import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MACHINE_SHARED_SETTING_KEYS,
  type MachineSharedSettingKey,
  ProviderInstanceId,
  ProviderDriverKind,
  ServerSettingsError,
  type ServerSettingsPatch,
  type ServerProvider,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as SharedSettings from "../../../sharedSettings/SharedSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(SharedSettings.SharedSettings)({
        update: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

it.effect.each([
  {
    name: "local full-access client",
    linked: false,
    access: "full-access",
    invalid: false,
    denied: undefined,
  },
  {
    name: "full-access linked machine",
    linked: true,
    access: "full-access",
    invalid: false,
    denied: undefined,
  },
  {
    name: "link paired below full access",
    linked: true,
    access: "approval-required",
    invalid: false,
    denied: "capability_denied",
  },
  {
    name: "unknown scheduled model",
    linked: false,
    access: "full-access",
    invalid: true,
    denied: "model_unavailable",
  },
  {
    name: "account with no model catalog",
    linked: false,
    access: "full-access",
    invalid: false,
    emptyCatalog: true,
    denied: "model_unavailable",
  },
  {
    name: "unknown Auto model",
    linked: false,
    access: "full-access",
    invalid: false,
    invalidAuto: true,
    denied: "model_unavailable",
  },
  {
    name: "unknown delegated model",
    linked: false,
    access: "full-access",
    invalid: false,
    invalidDelegated: true,
    denied: "model_unavailable",
  },
  {
    name: "unknown delegated account",
    linked: false,
    access: "full-access",
    invalid: false,
    missingDelegatedAccount: true,
    denied: "model_unavailable",
  },
  {
    name: "invalid delegated effort",
    linked: false,
    access: "full-access",
    invalid: false,
    invalidDelegatedEffort: true,
    denied: "invalid_request",
  },
] as const)("sets model defaults only for $name", ({ linked, access, invalid, denied, ...row }) =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_work");
    const driver = ProviderDriverKind.make("codex");
    const provider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-08T00:00:00.000Z",
      models:
        "emptyCatalog" in row
          ? []
          : [
              {
                slug: "astra",
                name: "Astra",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Effort",
                      type: "select",
                      options: [{ id: "high", label: "High" }],
                    },
                  ],
                },
              },
            ],
      slashCommands: [],
      skills: [],
    };
    const stored = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
    const dependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "client:models",
        thread: undefined,
        client: { sessionId: "models", label: "Peer", linked, access },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(SharedSettings.SharedSettings)({
        accountConfigs: () => Effect.succeed({}),
        update: (patch) =>
          Ref.updateAndGet(stored, (settings) => applyServerSettingsPatch(settings, patch)),
      }),
      Layer.mock(Settings.ServerSettingsService)({ getSettings: Ref.get(stored) }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const selection = { instanceId, model: invalid ? "typo" : "astra" };
      const auto = {
        model: "invalidAuto" in row ? "typo" : "astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      const delegated = {
        instanceId:
          "missingDelegatedAccount" in row ? ProviderInstanceId.make("missing") : instanceId,
        model: "invalidDelegated" in row ? "typo" : "astra",
        options: [
          { id: "reasoningEffort", value: "invalidDelegatedEffort" in row ? "invalid" : "high" },
        ],
      };
      const result = yield* toolkit
        .handle("t3_environment_preferences_update", {
          delegatedTaskModelSelections: {
            implementation: delegated,
            review: { instanceId, model: "astra" },
          },
          scheduledTaskModelSelection: selection,
          defaultModelSelection: { instanceId, model: "astra" },
          autoModeModels: { [driver]: auto },
          providerUpdates: "automatic",
          installUpdatesAutomatically: true,
          minHoursBetweenAutomaticUpdates: 12,
          usageLimitRecovery: "switch-and-resume",
          snoozeLimitedThreads: true,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      if (denied !== undefined) {
        expect(result.at(-1)?.result).toMatchObject({ code: denied });
        expect(yield* Ref.get(stored)).toEqual(DEFAULT_SERVER_SETTINGS);
      } else {
        expect(result.at(-1)?.result).toMatchObject({
          delegatedTaskModelSelections: { implementation: delegated },
          scheduledTaskModelSelection: selection,
          autoModeModels: { [driver]: auto },
          providerUpdates: "automatic",
          installUpdatesAutomatically: true,
          minHoursBetweenAutomaticUpdates: 12,
          usageLimitRecovery: "switch-and-resume",
          snoozeLimitedThreads: true,
        });
        expect(yield* Ref.get(stored)).toMatchObject({
          installUpdatesAutomatically: true,
          minHoursBetweenAutomaticUpdates: 12,
          enableProviderUpdateChecks: true,
          autoUpdateProviders: true,
          snoozeLimitedThreads: true,
          autoResumeLimitedThreads: true,
          failoverLimitedThreads: true,
        });
        const read = yield* toolkit
          .handle("t3_environment_read", {})
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(read.at(-1)?.result).toMatchObject({
          preferences: {
            delegatedTaskModelSelections: { implementation: delegated },
            scheduledTaskModelSelection: selection,
            autoModeModels: { [driver]: auto },
            installUpdatesAutomatically: true,
            minHoursBetweenAutomaticUpdates: 12,
            usageLimitRecovery: "switch-and-resume",
            snoozeLimitedThreads: true,
          },
        });
        for (const usageLimitRecovery of ["off", "resume", "switch-and-resume"] as const) {
          yield* toolkit
            .handle("t3_environment_preferences_update", { usageLimitRecovery })
            .pipe(Stream.unwrap, Stream.runDrain);
          expect((yield* Ref.get(stored)).snoozeLimitedThreads).toBe(true);
        }
        yield* toolkit
          .handle("t3_environment_preferences_update", { usageLimitRecovery: "snooze" })
          .pipe(Stream.unwrap, Stream.runDrain);
        expect(yield* Ref.get(stored)).toMatchObject({
          snoozeLimitedThreads: true,
          autoResumeLimitedThreads: false,
          failoverLimitedThreads: false,
        });
        yield* toolkit
          .handle("t3_environment_preferences_update", {
            usageLimitRecovery: "resume",
            snoozeLimitedThreads: false,
          })
          .pipe(Stream.unwrap, Stream.runDrain);
        expect(yield* Ref.get(stored)).toMatchObject({
          snoozeLimitedThreads: false,
          autoResumeLimitedThreads: true,
          failoverLimitedThreads: false,
        });
        yield* toolkit
          .handle("t3_environment_preferences_update", {
            delegatedTaskModelSelections: { implementation: null },
            scheduledTaskModelSelection: null,
            autoModeModels: { [driver]: null },
            enableProviderUpdateChecks: false,
          })
          .pipe(Stream.unwrap, Stream.runDrain);
        expect((yield* Ref.get(stored)).delegatedTaskModelSelections).toEqual({
          review: { instanceId, model: "astra" },
        });
        expect((yield* Ref.get(stored)).scheduledTaskModelSelection).toBeNull();
        expect((yield* Ref.get(stored)).autoModeModels[driver]).toBeUndefined();
        expect((yield* Ref.get(stored)).autoUpdateProviders).toBe(false);
      }
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  }),
);

it.effect.each([
  { name: "follows shared settings", follows: true, allMachines: true, shared: true },
  {
    name: "follows shared settings, one machine",
    follows: true,
    allMachines: false,
    shared: false,
  },
  {
    name: "follows shared settings, sharing omitted",
    follows: true,
    allMachines: undefined,
    shared: false,
  },
  { name: "does not follow shared settings", follows: false, allMachines: true, shared: false },
])("allMachines on a machine that $name", ({ follows, allMachines, shared }) =>
  Effect.gen(function* () {
    const writes = yield* Ref.make<ReadonlyArray<"all machines" | "this machine">>([]);
    const stored = yield* Ref.make({ ...DEFAULT_SERVER_SETTINGS, followSharedSettings: follows });
    const save = (patch: ServerSettingsPatch, target: "all machines" | "this machine") =>
      Ref.update(writes, (all) => [...all, target]).pipe(
        Effect.andThen(
          Ref.updateAndGet(stored, (current) => applyServerSettingsPatch(current, patch)),
        ),
      );
    const dependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "client:shared",
        thread: undefined,
        client: { sessionId: "shared", label: "Peer", linked: false, access: "full-access" },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(SharedSettings.SharedSettings)({
        accountConfigs: () => Effect.succeed({}),
        update: (patch, share) =>
          save(patch, share === undefined ? "this machine" : "all machines"),
        updateForAllMachines: (patch) =>
          save(patch, "all machines").pipe(
            Effect.map((settings) => ({
              settings,
              share: {
                stamp: { updatedAt: "2026-11-11T12:00:00.000Z", origin: environmentId },
                values: [],
              },
            })),
          ),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Ref.get(stored),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const resetPreferences = { redeemUsageResets: true, maxPlanResetWaitHours: 168 };
      const result = yield* toolkit
        .handle("t3_environment_preferences_update", {
          newWorktreesStartFromOrigin: false,
          ...resetPreferences,
          ...(allMachines === undefined ? {} : { allMachines }),
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      if (allMachines && !follows) {
        expect(result.at(-1)?.result).toMatchObject({ code: "invalid_request" });
        expect(yield* Ref.get(writes)).toEqual([]);
        return;
      }

      expect(yield* Ref.get(writes)).toEqual([shared ? "all machines" : "this machine"]);
      expect(yield* Ref.get(stored)).toMatchObject(resetPreferences);
      expect(result.at(-1)?.result).toMatchObject(resetPreferences);
      const read = yield* toolkit
        .handle("t3_environment_read", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toMatchObject({ preferences: resetPreferences });
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  }),
);

it("refuses a plan reset wait longer than 168 hours", () => {
  const decode = Schema.decodeUnknownSync(
    EnvironmentToolkit.tools.t3_environment_preferences_update.parametersSchema,
  );
  expect(() => decode({ maxPlanResetWaitHours: 169 })).toThrow(/maxPlanResetWaitHours/);
});

it("accepts preferences from older linked machines without the reset settings", () => {
  const {
    redeemUsageResets: _redeem,
    maxPlanResetWaitHours: _wait,
    ...olderPreferences
  } = EnvironmentHandlers.preferences(DEFAULT_SERVER_SETTINGS);
  const decode = Schema.decodeUnknownSync(
    EnvironmentToolkit.tools.t3_environment_read.successSchema.fields.preferences,
  );
  expect(decode(olderPreferences)).toEqual(olderPreferences);
});

const WORK = ProviderInstanceId.make("claudeAgent_work");
const workAccount = {
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude - Work",
  config: { homePath: "/home/user/.claude-work" },
};

/** Settings in which an administrator's policy locks one preference, refusing writes that set it. */
const lockingNewWorktrees = (
  real: Settings.ServerSettingsService["Service"],
): Settings.ServerSettingsService["Service"] => {
  const locked = new ServerSettingsError({
    settingsPath: "test settings",
    operation: "write-managed-setting",
    managedSetting: "newWorktreesStartFromOrigin",
    managedBy: "Example Corp",
  });
  return {
    ...real,
    updateSettings: (patch, hooks) =>
      patch.newWorktreesStartFromOrigin === undefined
        ? real.updateSettings(patch, hooks)
        : Effect.fail(locked),
    updateProviderInstance: (mutation, patch = {}, hooks) =>
      patch.newWorktreesStartFromOrigin === undefined
        ? real.updateProviderInstance(mutation, patch, hooks)
        : Effect.fail(locked),
  };
};

it.effect.each([
  { name: "an added account", accounts: { [WORK]: { autoCompactWindow: "300000" } } },
  {
    name: "an added account on every machine",
    accounts: { [WORK]: { autoCompactWindow: "300000" } },
    allMachines: true,
  },
  {
    name: "a path",
    accounts: { [WORK]: { binaryPath: "/tmp/claude" } },
    refused: "cannot set binaryPath",
  },
  {
    name: "a built-in account on every machine",
    accounts: { claudeAgent: { autoCompactWindow: "300000" } },
    allMachines: true,
    refused: "is a built-in account",
  },
  {
    name: "an account beside a preference a policy locks",
    accounts: { [WORK]: { autoCompactWindow: "300000" } },
    newWorktreesStartFromOrigin: false,
    refused: "newWorktreesStartFromOrigin is managed by Example Corp",
  },
] as const)("providerAccounts sets $name, or says why not", ({ accounts, ...row }) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "client:accounts",
        thread: undefined,
        client: { sessionId: "accounts", label: "Peer", linked: false, access: "full-access" },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      SharedSettings.layerTest.pipe(
        Layer.provideMerge(
          Layer.effect(
            Settings.ServerSettingsService,
            Settings.ServerSettingsService.pipe(
              Effect.map((real) =>
                "newWorktreesStartFromOrigin" in row ? lockingNewWorktrees(real) : real,
              ),
            ),
          ).pipe(
            Layer.provide(
              Settings.ServerSettingsService.layerTest({
                followSharedSettings: true,
                providerInstances: { [WORK]: workAccount },
              }),
            ),
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const settings = yield* Settings.ServerSettingsService;
      const before = yield* settings.getSettings;
      const result = yield* toolkit
        .handle("t3_environment_preferences_update", {
          providerAccounts: accounts,
          ...("allMachines" in row ? { allMachines: row.allMachines } : {}),
          ...("newWorktreesStartFromOrigin" in row
            ? { newWorktreesStartFromOrigin: row.newWorktreesStartFromOrigin }
            : {}),
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      if ("refused" in row) {
        expect(result.at(-1)?.result).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining(row.refused),
        });
        expect(yield* settings.getSettings).toEqual(before);
        return;
      }
      const shown = {
        [WORK]: {
          driver: "claudeAgent",
          displayName: "Claude - Work",
          sharedWithMachines: true,
          config: { customModels: [], autoCompactWindow: "300000", idleCompaction: "default" },
        },
      };
      expect(result.at(-1)?.result).toMatchObject({ providerAccounts: shown });
      expect((yield* settings.getSettings).providerInstances[WORK]).toEqual({
        ...workAccount,
        config: { ...workAccount.config, autoCompactWindow: "300000" },
      });
      const read = yield* toolkit
        .handle("t3_environment_read", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toMatchObject({ providerAccounts: shown });
      // A linked machine on an older version answers both without providerAccounts.
      for (const [tool, answer] of [
        [EnvironmentToolkit.tools.t3_environment_read, read],
        [EnvironmentToolkit.tools.t3_environment_preferences_update, result],
      ] as const) {
        const { providerAccounts: _shown, ...older } = (answer.at(-1)?.encodedResult ?? {}) as {
          providerAccounts?: unknown;
        };
        const decodeAnswer = Schema.decodeUnknownEffect(tool.successSchema);
        expect(yield* decodeAnswer(older)).not.toHaveProperty("providerAccounts");
      }
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  }),
);

const SHARED_SETTING_EXCLUSIONS = {
  newThreadsUseLastModel:
    "The user chooses whether new chats inherit their last model in Settings.",
  fallbackModelSelection:
    "The user chooses which model can replace their selected model in Settings.",
  textGenerationModelSelection:
    "The user selects the model for background text generation in Settings.",
  threadTitleInstructions:
    "The user controls the instructions for generated thread titles in Settings.",
  sourceControlWriterModelSelection: "The user selects the model that writes commits and PR text.",
  reviewGuideModelSelection: "The user selects the model that generates review guides.",
  finalReviewByDefault: "The user sets when new threads should request a final review.",
  defaultRuntimeMode: "The user chooses the default approval mode for future agent turns.",
  responseStreamingMode: "The user controls how streamed responses appear in clients.",
  idleCompaction: "The user controls automatic compaction of idle conversation context.",
  snoozePresets: "Clients use these presets in the user's snooze menu.",
  autoResumeLimitedThreads: "The tools read and update recovery modes through usageLimitRecovery.",
  failoverLimitedThreads: "The tools read and update recovery modes through usageLimitRecovery.",
  sidebarAutoSettleAfterDays: "The user decides how long idle threads remain in the sidebar.",
  sidebarAutoSettleOnMerge: "The user decides whether a merge automatically settles a thread.",
  sidebarAutoSettleScheduledThreads:
    "The user decides whether completed scheduled threads settle automatically.",
  sidebarAutoSettleKeepPullRequests:
    "The user decides whether pull requests keep their threads visible.",
  sidebarAutoSettleOpensPullRequests:
    "The user decides whether auto-settlement may open pull requests.",
  scheduledTaskDefaultPlacement: "The user chooses the default placement for new scheduled tasks.",
  skillAvailability: "The user controls the skills their providers can see.",
  enableAgentBrowserAccess: "The user grants agents access to the browser.",
  enableAgentDeviceAccess: "The user grants agents access to devices.",
  agentTerminalAccess: "The user grants agents access to the terminal.",
  worktreeSubmodules: "The user controls submodule initialization for new worktrees.",
  defaultAutoPull: "The user controls automatic pulls in their checkouts.",
  worktreeCleanup: "The user decides when CodeShip can remove worktrees automatically.",
  branchNamingMode: "The user selects the default branch naming convention.",
  removeAgentCreditsOnMerge: "The user selects the attribution policy for merges.",
  pullRequestMergeMethod: "The user selects the default pull request merge method.",
  reviewGuidesEnabled: "The user decides whether CodeShip generates review guides.",
  reviewGuideInstructions: "The user controls the instructions for generated review guides.",
  importAgentConversations: "The user opts in to importing conversations from provider history.",
  ghqCloneLayout: "The user controls the directory layout for cloned projects.",
  autoUpdateProviders: "The tools read and update provider update modes through providerUpdates.",
  continueThreadsAfterServerUpdate:
    "The user decides whether interrupted turns resume after updates.",
  providerInstanceFailoverOrder:
    "The user controls which accounts can be tried first during failover.",
  deviceSettingsProfile:
    "Clients synchronize the user's appearance and device preferences as a profile.",
} satisfies Partial<Record<MachineSharedSettingKey, string>>;

it("exposes every machine-shared setting or documents its exclusion", () => {
  const writable = Object.keys(
    EnvironmentToolkit.tools.t3_environment_preferences_update.parametersSchema.fields,
  );
  const readable = Object.keys(
    EnvironmentToolkit.tools.t3_environment_read.successSchema.fields.preferences.fields,
  );
  const exposed = (field: string) => writable.includes(field) && readable.includes(field);
  const missing = MACHINE_SHARED_SETTING_KEYS.filter(
    (key) => !exposed(key) && !Object.hasOwn(SHARED_SETTING_EXCLUSIONS, key),
  );
  expect(missing).toEqual([]);
  expect(["usageLimitRecovery", "providerUpdates"].filter((field) => !exposed(field))).toEqual([]);
});

it("keeps agent feedback out of the preferences agents read and write", () => {
  expect(
    EnvironmentHandlers.preferences({
      ...DEFAULT_SERVER_SETTINGS,
      agentFeedback: { mode: "auto" },
    }),
  ).not.toHaveProperty("agentFeedback");
  expect(
    Object.keys(EnvironmentToolkit.tools.t3_environment_preferences_update.parametersSchema.fields),
  ).not.toContain("agentFeedback");
});
