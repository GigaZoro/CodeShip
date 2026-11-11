import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
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
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
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
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Ref.get(stored),
        updateSettings: (patch) =>
          Ref.updateAndGet(stored, (settings) => applyServerSettingsPatch(settings, patch)),
      }),
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
          usageLimitRecovery: "switch-and-resume",
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
          usageLimitRecovery: "switch-and-resume",
        });
        expect(yield* Ref.get(stored)).toMatchObject({
          enableProviderUpdateChecks: true,
          autoUpdateProviders: true,
          snoozeLimitedThreads: false,
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
          },
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
