import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ManualStepStartChatInput,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ManualStepChats from "./ManualStepChats.ts";

const scratchProjectId = ProjectId.make("project:scratch");
const signedOut = ProviderInstanceId.make("codex");
const signedIn = ProviderInstanceId.make("claude_second");
const environmentId = EnvironmentId.make("environment:manual-steps");

const claude = ProviderDriverKind.make("claudeAgent");

const provider = (
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: claude,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-11T11:59:00.000Z",
  models: [
    { slug: "small", name: "Small", isCustom: false, capabilities: null },
    { slug: "large", name: "Large", isCustom: false, isDefault: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const input: ManualStepStartChatInput = {
  commandId: CommandId.make("command:decide"),
  creationSource: "mobile",
  step: {
    threadId: "contabo",
    title: "Move the VPS contract to a 12-month term",
    step: "in the Contabo panel, move the VPS to a 12-month term.",
    kind: "needs-you",
    machine: "MacBook-Pro",
    url: "https://thread.page/app/threads/contabo",
  },
  decision: { _tag: "Other", text: "Keep the monthly term and close this step." },
};

type SettingsOverrides = Parameters<typeof ServerSettings.layerTest>[0];

interface Scenario {
  readonly settings?: SettingsOverrides;
  readonly quotaAwareAuto?: boolean | undefined;
  /** The model of the chat an earlier attempt with this command id already started. */
  readonly startedModel?: ModelSelection;
  readonly firstRunId?: RunId;
}

const layerFor = (
  providers: ReadonlyArray<ServerProvider>,
  launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>,
  { settings, startedModel, quotaAwareAuto, firstRunId }: Scenario,
) =>
  ManualStepChats.layer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.succeed<ExecutionEnvironmentDescriptor>({
          environmentId,
          label: "Manual steps",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.0.0",
          capabilities: {
            repositoryIdentity: false,
            ...(quotaAwareAuto === undefined ? {} : { quotaAwareAuto }),
          },
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
    ),
    Layer.provide(Layer.mock(Project.ProjectService)({ getById: () => Effect.succeedNone })),
    // Manual-step chats always run in the checkout, so they never ask git for a worktree base.
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({ load: () => Effect.succeedNone }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            startedModel === undefined
              ? null
              : {
                  ...liveThreadShell(threadId),
                  projectId: scratchProjectId,
                  modelSelection: startedModel,
                  latestUserMessageAt:
                    firstRunId === undefined ? null : DateTime.makeUnsafe("2026-11-11T12:00:00Z"),
                },
          ),
        getThreadRecords: (threadId, _kinds, filter) => {
          const id = MessageId.make(input.commandId);
          const records = idleThreadProjection({
            ...liveThreadShell(threadId),
            projectId: scratchProjectId,
          });
          const messages: OrchestrationV2ConversationMessage[] = [];
          if (firstRunId !== undefined && filter?.messageIds?.includes(id)) {
            messages.push({
              id,
              threadId,
              runId: firstRunId,
              nodeId: null,
              role: "user",
              createdBy: "user",
              creationSource: "mobile",
              text: input.step.step,
              attachments: [],
              streaming: false,
              createdAt: records.updatedAt,
              updatedAt: records.updatedAt,
            });
          }
          return Effect.succeed({ ...records, messages });
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        prepareRun: () => Effect.void,
        launch: (request) =>
          Ref.update(launches, (seen) => [...seen, request]).pipe(
            Effect.as({
              threadId: ThreadId.make("thread:decision"),
              resumed: false,
            } as ThreadLaunch.ThreadLaunchResult),
          ),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        ...settings,
        providerInstances: {
          [signedOut]: { driver: claude },
          [signedIn]: { driver: claude },
          ...settings?.providerInstances,
        },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const start = (providers: ReadonlyArray<ServerProvider>, scenario: Scenario = {}) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const result = yield* ManualStepChats.ManualStepChats.pipe(
      Effect.flatMap((chats) => chats.start(input)),
      Effect.provide(layerFor(providers, launches, scenario).pipe(Layer.orDie)),
      Effect.result,
    );
    return { result, launches: yield* Ref.get(launches) };
  });

describe("ManualStepChats", () => {
  it.effect("starts a No project chat on the first account that can run it", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([
        provider(signedOut, { auth: { status: "unauthenticated" } }),
        provider(signedIn),
      ]);
      expect(result).toMatchObject({ _tag: "Success", success: { threadId: "thread:decision" } });
      expect(launches).toHaveLength(1);
      const [launch] = launches;
      expect(launch).toMatchObject({
        commandId: input.commandId,
        threadId: input.commandId,
        projectId: scratchProjectId,
        title: "Move the VPS contract to a 12-month term",
        modelSelection: { instanceId: signedIn, model: "large" },
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "mobile",
      });
      const text = launch?.initialMessage?.text ?? "";
      expect(text).toContain("My decision: Keep the monthly term and close this step.");
      expect(text).toContain("https://thread.page/app/threads/contabo");
      expect(text).toContain("Spend only what my decision above explicitly approves.");
    }),
  );

  it.effect.each([
    ["is turned off", { enabled: false }, provider(signedOut)],
    ["is signed out", {}, provider(signedOut, { auth: { status: "unauthenticated" } })],
  ] as const)("skips a default model whose account %s", ([, instance, defaultAccount]) =>
    Effect.gen(function* () {
      const { launches } = yield* start([defaultAccount, provider(signedIn)], {
        settings: {
          defaultModelSelection: { instanceId: signedOut, model: "small" },
          providerInstances: { [signedOut]: { driver: claude, ...instance } },
        },
      });
      expect(launches[0]?.modelSelection).toEqual({ instanceId: signedIn, model: "large" });
    }),
  );

  it.effect.each([
    [
      "moves an auto-account default off a turned-off account",
      { autoAccount: true },
      { instanceId: signedIn, model: "small", autoAccount: true },
    ],
    [
      "preserves quota-aware Auto for the turn router when its placeholder account is off",
      { quotaAwareAuto: true },
      { instanceId: signedOut, model: "small", quotaAwareAuto: true },
    ],
  ] as const)("%s", ([, mode, expected]) =>
    Effect.gen(function* () {
      const { launches } = yield* start([provider(signedOut), provider(signedIn)], {
        quotaAwareAuto: true,
        settings: {
          defaultModelSelection: { instanceId: signedOut, model: "small", ...mode },
          providerInstances: { [signedOut]: { driver: claude, enabled: false } },
        },
      });
      expect(launches[0]?.modelSelection).toEqual(expected);
    }),
  );

  it.effect.each([
    ["omits support", undefined, true],
    ["disables support", false, false],
  ] as const)("refuses a quota-aware default when the destination %s", ([, supported, enabled]) =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([provider(signedOut), provider(signedIn)], {
        quotaAwareAuto: supported,
        settings: {
          defaultModelSelection: { instanceId: signedOut, model: "small", quotaAwareAuto: true },
          providerInstances: { [signedOut]: { driver: claude, enabled } },
        },
      });
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "no-model", quotaAwareAutoUnsupported: true },
      });
      expect(launches).toEqual([]);
    }),
  );

  it.effect("refuses a quota-aware fallback when the default is out of quota", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const limited = provider(signedOut, {
        usageLimits: {
          checkedAt: DateTime.formatIso(now),
          windows: [
            {
              id: "5h",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
            },
          ],
        },
      });
      const { result, launches } = yield* start([limited, provider(signedIn)], {
        settings: {
          defaultModelSelection: { instanceId: signedOut, model: "small" },
          fallbackModelSelection: { instanceId: signedIn, model: "large", quotaAwareAuto: true },
        },
      });
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "no-model", quotaAwareAutoUnsupported: true },
      });
      expect(launches).toEqual([]);
    }),
  );

  it.effect("replays a repeated request on the model its chat started with", () =>
    Effect.gen(function* () {
      const startedModel = { instanceId: signedOut, model: "small" };
      const { result, launches } = yield* start([provider(signedOut, { enabled: false })], {
        startedModel,
      });
      expect(result._tag).toBe("Success");
      expect(launches[0]).toMatchObject({
        threadId: input.commandId,
        modelSelection: startedModel,
      });
    }),
  );

  it.effect("reopens an accepted Auto chat after the destination loses support", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([], {
        startedModel: { instanceId: signedOut, model: "small", quotaAwareAuto: true },
        firstRunId: RunId.make("run:decision"),
      });
      expect(result).toMatchObject({
        _tag: "Success",
        success: { threadId: input.commandId, resumed: true },
      });
      expect(launches).toEqual([]);
    }),
  );

  it.effect("starts nothing when no account can run a chat", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([provider(signedOut, { enabled: false })]);
      expect(result._tag === "Failure" ? result.failure.reason : null).toBe("no-model");
      expect(launches).toHaveLength(0);
    }),
  );
});
