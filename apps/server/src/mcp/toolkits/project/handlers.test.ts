import * as ProviderMcp from "../../../provider/ProviderMcp.ts";
// @effect-diagnostics nodeBuiltinImport:off - a directory junction needs no privilege on Windows.
import * as NodeFSP from "node:fs/promises";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GitCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type Project as ProjectRecord,
  type ModelSelection,
  type ProjectScript,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
  type ChatAttachment,
  ChatAttachmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as DocumentText from "../../../provider/DocumentText.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as AccountRouting from "../../../orchestration-v2/AccountRouting.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as MemoryAdmission from "../../../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../../../attachmentStore.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const advertisedProvider = (
  instanceId: string,
  models: ReadonlyArray<string>,
  aliases: Readonly<Record<string, ReadonlyArray<string>>> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-28T00:00:00.000Z",
  models: models.map((slug) => ({
    slug,
    name: slug,
    ...(aliases[slug] === undefined ? {} : { aliases: aliases[slug] }),
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

const defaultProviders = [
  advertisedProvider("claudeAgent", ["claude-opus", "claude-sonnet"], {
    "claude-opus": ["opus"],
  }),
  advertisedProvider("codex", ["gpt-settings"]),
];

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly defaultThreadEnvMode?: "local" | "worktree";
  readonly fallbackModel?: ModelSelection;
  readonly providers?: readonly ServerProvider[];
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly overrideScripts?: readonly ProjectScript[];
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly client?: Pick<McpInvocationContext.McpClientCaller, "linked" | "narrowedTo">;
  readonly launchShell?: (
    shell: OrchestrationV2ThreadShell,
    read: "lookup" | "result",
  ) => OrchestrationV2ThreadShell;
  /** Each default model a project was made or changed with. */
  readonly savedDefaults?: Array<ModelSelection | null | undefined>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  readonly hostedAppUrl?: string;
  /** The orchestrator refuses the new thread's mode, as under a managed ceiling. */
  readonly refusedByCeiling?: true;
  readonly autoModeProvider?: ProviderDriverKind;
  /** Accounts a usage limit stopped, with their resets. */
  readonly limited?: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<ProjectionStore.RecordedUsageLimit>
  >;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  /** A thread calls instead of a client: the first shell, whose parents follow it. */
  readonly callerThreads?: ReadonlyArray<{
    readonly shell: OrchestrationV2ThreadShell;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }>;
}) => {
  const callerThread = input.callerThreads?.[0]?.shell;
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  // The project's own default model, which a test can clear between launches.
  const projectDefaults: { model: ModelSelection | null } = {
    model: input.overrideModel === undefined ? modelSelection : null,
  };
  const launchShell = (launch: ThreadLaunch.ThreadLaunchInput, read: "lookup" | "result") => {
    const shell = {
      ...McpToolAccessTestkit.liveThreadShell(
        ThreadId.make(launch.threadId ?? launch.commandId),
        launch,
      ),
      projectId: launch.projectId,
      modelSelection: launch.modelSelection,
      title: launch.title,
      ...(launch.linkOrigin === undefined ? {} : { linkOrigin: launch.linkOrigin }),
    };
    return input.launchShell?.(shell, read) ?? shell;
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest({
      fallbackModelSelection: input.fallbackModel ?? null,
      ...(input.autoModeProvider === undefined
        ? {}
        : {
            autoModeProvider: input.autoModeProvider,
            autoModeModels: { [input.autoModeProvider]: { model: "claude-sonnet" } },
          }),
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...input.settings,
      ...(input.newWorktreesStartFromOrigin === undefined
        ? {}
        : { newWorktreesStartFromOrigin: input.newWorktreesStartFromOrigin }),
      ...(input.defaultThreadEnvMode === undefined
        ? {}
        : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: {
                defaultModelSelection: input.overrideModel,
                ...(input.overrideScripts === undefined
                  ? {}
                  : { defaultProjectScripts: input.overrideScripts }),
              },
            },
          }),
    }),
    NodeCrypto.layer,
    MemoryAdmission.layerTest(),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread:
        callerThread === undefined
          ? undefined
          : {
              threadId: callerThread.id,
              providerSessionId: "session-1",
              providerInstanceId: callerThread.modelSelection.instanceId,
            },
      client:
        callerThread === undefined
          ? {
              sessionId: "session-1",
              label: "Claude Code",
              access: input.runtimeModeCeiling,
              hostedAppUrl: input.hostedAppUrl,
              ...input.client,
            }
          : undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // A thread exists once a launch started it.
      getThreadShell: (threadId) => {
        const caller = input.callerThreads?.find(({ shell }) => shell.id === threadId);
        if (caller !== undefined) return Effect.succeed(caller.shell);
        const launch = input.launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(launch === undefined ? null : launchShell(launch, "lookup"));
      },
      getThreadRecords: (threadId) =>
        Effect.succeed({
          messages: [
            {
              attachments:
                input.callerThreads?.find(({ shell }) => shell.id === threadId)?.attachments ?? [],
            },
          ],
        } as never),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        if (input.refusedByCeiling) {
          return Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              operation: "create-thread",
              commandId: launch.commandId,
              projectId: launch.projectId,
              cause: new OrchestratorRuntimeModeAboveCeilingError({
                commandId: launch.commandId,
                threadId: launch.threadId ?? ThreadId.make("thread:refused"),
                refused: "mode",
                runtimeMode: launch.runtimeMode,
                maxRuntimeMode: "approval-required",
                organization: "Example Corp",
              }),
            }),
          );
        }
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: launchShell(launch, "result"),
            runs: [],
            messages:
              launch.initialMessage === undefined
                ? []
                : [{ attachments: launch.initialMessage.attachments }],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: projectDefaults.model,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
      workspaceScanDirectory: Effect.succeed,
      create: (create) => {
        input.savedDefaults?.push(create.defaultModelSelection);
        return Effect.fail(new Project.ProjectNotFoundError({ projectId: create.projectId }));
      },
      update: (update) => {
        input.savedDefaults?.push(update.defaultModelSelection);
        return Effect.fail(new Project.ProjectNotFoundError({ projectId: update.projectId }));
      },
    }),
    Layer.mock(ProviderMcp.ProviderMcp)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshWorkspaceSnapshot: () => Effect.succeed(input.providers ?? defaultProviders),
      getProviders: Effect.succeed(input.providers ?? defaultProviders),
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getUsageLimitedProviderInstances: () => Effect.succeed(input.limited ?? new Map()),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      createNamedProject: (named) => {
        input.savedDefaults?.push(named.defaultModelSelection);
        return Effect.succeed({
          projectId: ProjectId.make("named"),
          workspaceRoot: "/projects/named",
        });
      },
    }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return {
    projectId,
    modelSelection,
    projectDefaults,
    dependencies: AccountRouting.layer.pipe(Layer.provideMerge(layerDependencies)),
  };
};

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly generateTitle?: boolean;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
          readonly hostedAppUrl?: string;
          readonly refusedByCeiling?: true;
        },
      ) {
        const { targeted, overrideModel, hostedAppUrl, refusedByCeiling, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
          ...(hostedAppUrl === undefined ? {} : { hostedAppUrl }),
          ...(refusedByCeiling === undefined ? {} : { refusedByCeiling }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", targeted === false ? input : { ...input, projectId })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
        link: `[Fix](t3-thread://v2/environment/${belowCeiling.launched[0]?.threadId})`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();
      expect(belowCeiling.launched[0]?.generateTitle).toBeUndefined();
      expect(belowCeiling.launched[0]?.titleRenamed).toBe(true);

      const titled = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        generateTitle: true,
        message: "Fix the bug",
      });
      expect(titled.launched[0]).toMatchObject({ title: "Fix", generateTitle: true });
      expect(titled.launched[0]?.titleRenamed).toBeUndefined();

      for (const message of [undefined, "", " \n "]) {
        const idleTitled = yield* launchWith("full-access", "full-access", {
          title: "Fix",
          generateTitle: true,
          ...(message === undefined ? {} : { message }),
        });
        expect(idleTitled.result).toMatchObject({ code: "invalid_request" });
        expect(idleTitled.launched).toHaveLength(0);
      }

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", {
        title: "Fix",
        hostedAppUrl: "https://t3.example.com",
      });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");
      expect(aboveCeiling.result).toMatchObject({
        link: `https://t3.example.com/threads/environment/${encodeURIComponent(aboveCeiling.launched[0]?.threadId ?? "")}`,
      });

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "auto",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("auto");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);

      // An administrator's ceiling the orchestrator enforces is named, not reported as unavailable.
      const managed = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        refusedByCeiling: true,
      });
      expect(managed.result).toMatchObject({
        code: "invalid_request",
        message: "Example Corp limits threads to Supervised.",
      });
    }),
);

/** A managed Codex account: its model has a reasoning effort and no serviceTier. */
const codexWithEffort: ServerProvider = {
  ...advertisedProvider("codex", []),
  models: [
    {
      slug: "gpt-settings",
      name: "gpt-settings",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
};
const laptopParent = {
  environmentId: EnvironmentId.make("environment-laptop"),
  threadId: ThreadId.make("thread:laptop-parent"),
  title: "Parent",
};

it.effect("a launch with a model or option its provider does not advertise creates no thread", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const savedDefaults: Array<ModelSelection | null | undefined> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      savedDefaults,
      providers: [
        advertisedProvider("claudeAgent", ["claude-opus", "claude-sonnet"], {
          "claude-opus": ["opus"],
        }),
        codexWithEffort,
      ],
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchWith = (
      instanceId: string,
      model: string,
      options?: ModelSelection["options"],
      claimed?: { readonly inheritedOptionIds: ReadonlyArray<string> },
    ) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug",
          modelSelection: {
            instanceId: ProviderInstanceId.make(instanceId),
            model,
            ...(options === undefined ? {} : { options }),
          },
          ...(claimed === undefined ? {} : { ...claimed, delegatedFrom: laptopParent }),
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((result) => result.at(-1)?.result),
          Effect.provide(dependencies),
        );

    for (const [instanceId, model] of [
      ["claudeAgent", "claude-issue-26619-unadvertised"],
      ["claudeAgent", "gpt-settings"],
      ["codex", "claude-opus"],
      ["codex", "opus"],
    ] as const) {
      expect(yield* launchWith(instanceId, model)).toMatchObject({
        code: "model_unavailable",
        message: expect.stringContaining(
          `Model ${model} is not advertised by provider ${instanceId}. Advertised models: `,
        ),
      });
    }
    expect(launched).toHaveLength(0);

    expect(yield* launchWith("claudeAgent", "claude-sonnet")).toMatchObject({
      projectId,
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet" },
    });
    expect(yield* launchWith("claudeAgent", "Opus")).toMatchObject({
      projectId,
      modelSelection: { instanceId: "claudeAgent", model: "Opus" },
    });
    expect(launched).toHaveLength(2);

    // As delegate_task checks its target.
    for (const [option, problem] of [
      [
        { id: "serviceTier", value: "fast" },
        "Unknown option serviceTier; supported options: reasoningEffort.",
      ],
      [
        { id: "reasoningEffort", value: "ultra" },
        "Option reasoningEffort must be one of: medium, high.",
      ],
    ] as const) {
      expect(yield* launchWith("codex", "gpt-settings", [option])).toMatchObject({
        code: "invalid_request",
        message: `Model gpt-settings on provider codex rejected options: ${problem}`,
      });
    }
    expect(launched).toHaveLength(2);
    expect(
      yield* launchWith("codex", "gpt-settings", [{ id: "reasoningEffort", value: "high" }]),
    ).toMatchObject({
      modelSelection: {
        model: "gpt-settings",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    // Only a link's own session may mark options as inherited, so this caller named them all.
    expect(
      yield* launchWith("codex", "gpt-settings", [{ id: "serviceTier", value: "fast" }], {
        inheritedOptionIds: ["serviceTier"],
      }),
    ).toMatchObject({
      code: "invalid_request",
      message:
        "Model gpt-settings on provider codex rejected options: Unknown option serviceTier; supported options: reasoningEffort.",
    });
    expect(launched).toHaveLength(3);

    // A project's default model is checked the same way before it is saved.
    const defaultModel = (options: ModelSelection["options"]) => ({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-settings",
      ...(options === undefined ? {} : { options }),
    });
    const saveDefaults = [
      (options: ModelSelection["options"]) =>
        toolkit
          .handle("t3_project_create", {
            title: "New",
            workspaceRoot: "/projects/new",
            defaultModelSelection: defaultModel(options),
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((result) => result.at(-1)?.result),
            Effect.provide(dependencies),
          ),
      (options: ModelSelection["options"]) =>
        toolkit
          .handle("t3_project_create", {
            title: "Named",
            defaultModelSelection: defaultModel(options),
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((result) => result.at(-1)?.result),
            Effect.provide(dependencies),
          ),
      (options: ModelSelection["options"]) =>
        toolkit
          .handle("t3_project_update", { projectId, defaultModelSelection: defaultModel(options) })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((result) => result.at(-1)?.result),
            Effect.provide(dependencies),
          ),
    ];
    for (const saveDefault of saveDefaults) {
      expect(yield* saveDefault([{ id: "serviceTier", value: "fast" }])).toMatchObject({
        code: "invalid_request",
        message:
          "Model gpt-settings on provider codex rejected options: Unknown option serviceTier; supported options: reasoningEffort.",
      });
      yield* saveDefault([{ id: "reasoningEffort", value: "high" }]);
    }
    expect(savedDefaults).toEqual(
      saveDefaults.map(() => defaultModel([{ id: "reasoningEffort", value: "high" }])),
    );
  }),
);

it.effect(
  "a linked environment's delegated task drops inherited options the model does not offer, also on a retry",
  () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "full-access",
        client: { linked: true },
        launched,
        providers: [codexWithEffort],
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const options = [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ];
      const launchWith = (
        clientRequestId: string,
        inheritedOptionIds?: ReadonlyArray<string>,
        selectionOptions = options,
      ) =>
        toolkit
          .handle("t3_thread_launch", {
            title: "Fix",
            projectId,
            message: "Fix the bug",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-settings",
              options: selectionOptions,
            },
            ...(inheritedOptionIds === undefined ? {} : { inheritedOptionIds }),
            delegatedFrom: laptopParent,
            clientRequestId,
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((result) => result.at(-1)?.result),
            Effect.provide(dependencies),
          );

      // The agent there named serviceTier itself.
      expect(yield* launchWith("delegate:named", ["reasoningEffort"])).toMatchObject({
        code: "invalid_request",
        message:
          "Model gpt-settings on provider codex rejected options: Unknown option serviceTier; supported options: reasoningEffort.",
      });
      expect(launched).toHaveLength(0);

      // Its parent's selection held it, as a task here drops a parent's option its model lacks.
      expect(
        yield* launchWith("delegate:inherited", ["reasoningEffort", "serviceTier"]),
      ).toMatchObject({
        modelSelection: { options: [{ id: "reasoningEffort", value: "high" }] },
      });
      // The retry replays the launch as it was accepted, not as it was asked for.
      yield* launchWith("delegate:inherited", ["reasoningEffort", "serviceTier"]);
      expect(launched).toHaveLength(2);
      expect(launched[1]?.modelSelection).toEqual(launched[0]?.modelSelection);

      // A link from before options were marked names none, so each counts as inherited.
      expect(yield* launchWith("delegate:older")).toMatchObject({
        modelSelection: { options: [{ id: "reasoningEffort", value: "high" }] },
      });
      expect(launched).toHaveLength(3);

      // A parent's selection can repeat an id, which runs here as on the laptop: its first entry.
      const repeated = [
        { id: "reasoningEffort", value: "high" },
        { id: "reasoningEffort", value: "medium" },
      ];
      expect(yield* launchWith("delegate:repeated", ["reasoningEffort"], repeated)).toMatchObject({
        modelSelection: { options: [{ id: "reasoningEffort", value: "high" }] },
      });
      expect(yield* launchWith("delegate:repeated-named", [], repeated)).toMatchObject({
        code: "invalid_request",
        message:
          "Model gpt-settings on provider codex rejected options: Option reasoningEffort was specified more than once.",
      });
      expect(launched).toHaveLength(4);
    }),
);

it.effect(
  "a launch with auto:true starts on Auto's model, and creates nothing while Auto is off",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        autoModeProvider: ProviderDriverKind | undefined,
        params: {
          readonly auto?: boolean;
          readonly modelSelection?: ModelSelection;
          readonly overrideModel?: ModelSelection;
        },
      ) {
        const { overrideModel, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, dependencies } = clientLaunchHarness({
          runtimeModeCeiling: "full-access",
          launched,
          ...(autoModeProvider === undefined ? {} : { autoModeProvider }),
          ...(overrideModel === undefined ? {} : { overrideModel }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", { ...input, projectId, title: "Fix", message: "Fix the bug" })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return {
          result: result.at(-1)?.result,
          selections: launched.map((launch) => launch.modelSelection),
        };
      });
      const claude = ProviderDriverKind.make("claudeAgent");

      expect((yield* launchWith(claude, { auto: true })).selections).toEqual([
        { instanceId: "claudeAgent", model: "claude-sonnet", autoAccount: true },
      ]);

      for (const [refused, code] of [
        [yield* launchWith(undefined, { auto: true }), "auto_mode_unavailable"],
        [
          yield* launchWith(claude, {
            auto: true,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-settings" },
          }),
          "invalid_request",
        ],
      ] as const) {
        expect(refused.result).toMatchObject({ code });
        expect(refused.selections).toEqual([]);
      }

      for (const explicit of [
        {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-settings",
          options: [{ id: "reasoningEffort", value: "high" }],
          autoAccount: true,
        },
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus",
          options: [{ id: "effort", value: "high" }],
          autoAccount: true,
        },
      ]) {
        expect((yield* launchWith(claude, { modelSelection: explicit })).selections).toEqual([
          { instanceId: explicit.instanceId, model: explicit.model, options: explicit.options },
        ]);
      }

      // auto:false runs the Auto default it would inherit as the model it names.
      const autoDefault = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus",
        autoAccount: true,
      };
      expect(
        (yield* launchWith(claude, { auto: false, overrideModel: autoDefault })).selections,
      ).toEqual([{ instanceId: "claudeAgent", model: "claude-opus" }]);
    }),
);

it.effect("a launch steps an inherited mode down to the provider's, and refuses one it lacks", () =>
  Effect.gen(function* () {
    // Pi offers no Auto; a mode a provider lacks would run as Supervised.
    const pi = ProviderInstanceId.make("pi");
    const launchPi = Effect.fn("test.launchPi")(function* (runtimeMode?: RuntimeMode) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        providers: [
          {
            instanceId: pi,
            driver: ProviderDriverKind.make("pi"),
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00Z",
            models: [],
            slashCommands: [],
            skills: [],
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          },
        ],
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          projectId,
          title: "Fix",
          modelSelection: { instanceId: pi, model: "pi-model" },
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return { result: result.at(-1)?.result, launched };
    });

    const inherited = yield* launchPi();
    expect(inherited.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launchPi("auto");
    expect(requested.result).toMatchObject({ code: "invalid_request" });
    expect(requested.launched).toHaveLength(0);

    const offered = yield* launchPi("approval-required");
    expect(offered.launched[0]?.runtimeMode).toBe("approval-required");
  }),
);

it.effect(
  "a launch rejects options its model does not declare and normalizes legacy ultracode effort",
  () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const providers: ServerProvider[] = [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          status: "ready",
          version: null,
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00Z",
          models: [
            {
              slug: "claude-opus-5-5",
              name: "Claude Opus 5.5",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    role: "reasoning",
                    label: "Effort",
                    type: "select",
                    options: [
                      { id: "high", label: "High" },
                      { id: "xhigh", label: "Extra High" },
                    ],
                  },
                  { id: "ultracode", label: "Ultracode", type: "boolean" },
                ],
              },
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        providers,
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const launchWith = (options: NonNullable<ModelSelection["options"]>) =>
        toolkit
          .handle("t3_thread_launch", {
            title: "Options check",
            projectId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-opus-5-5",
              options,
            },
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((result) => result.at(-1)?.result),
            Effect.provide(dependencies),
          );

      expect(yield* launchWith([{ id: "thought_level", value: "high" }])).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("Unknown option thought_level"),
      });
      expect(launched).toHaveLength(0);

      yield* launchWith([{ id: "effort", value: "ultracode" }]);
      expect(launched.map((launch) => launch.modelSelection.options)).toEqual([
        [
          { id: "effort", value: "xhigh" },
          { id: "ultracode", value: true },
        ],
      ]);
    }),
);

it.effect("only a full-access client may pick the agent's own mode at launch", () =>
  Effect.gen(function* () {
    const agent = ProviderInstanceId.make("acp-agent");
    const launchAs = (runtimeModeCeiling: "approval-required" | "full-access") =>
      Effect.gen(function* () {
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          launched,
          providers: [
            {
              instanceId: agent,
              driver: ProviderDriverKind.make("acpRegistry"),
              enabled: true,
              installed: true,
              status: "ready",
              version: null,
              auth: { status: "authenticated" },
              checkedAt: "2026-01-01T00:00:00Z",
              models: [
                {
                  slug: "default",
                  name: "Default",
                  isCustom: false,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "_t3/session-mode",
                        label: "Mode",
                        type: "select",
                        options: [
                          { id: "default", label: "Default" },
                          { id: "yolo", label: "YOLO" },
                        ],
                        currentValue: "default",
                      },
                    ],
                  },
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", {
            projectId,
            title: "Fix",
            message: "Fix the bug",
            modelSelection: {
              instanceId: agent,
              model: "default",
              options: [{ id: "_t3/session-mode", value: "yolo" }],
            },
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((collected) => collected.at(-1)?.result),
            Effect.provide(dependencies),
          );
        return { result, launched };
      });

    const supervised = yield* launchAs("approval-required");
    expect(supervised.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(supervised.launched).toHaveLength(0);

    const fullAccess = yield* launchAs("full-access");
    expect(fullAccess.launched.map((launch) => launch.modelSelection.options)).toEqual([
      [{ id: "_t3/session-mode", value: "yolo" }],
    ]);
  }),
);

it.effect("a launch retried with the same clientRequestId replays the first one", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string | undefined) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug",
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch("fix-1");
    yield* launch("fix-1");
    yield* launch("fix-2");
    yield* launch(undefined);
    yield* launch(undefined);
    const ids = launched.map((input) => [input.commandId, input.threadId]);
    // The same key sends the same command and thread ids, which the launch
    // service replays instead of starting a second thread.
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]?.[0]).toMatch(/^mcp:launch:[0-9a-f]{64}$/);
    expect(ids[2]).not.toEqual(ids[0]);
    // Without a key every launch is new.
    expect(ids[3]).not.toEqual(ids[4]);
  }),
);

it.effect.each([
  { change: { runtimeMode: "full-access" }, code: "runtime_mode_escalation_denied" },
  { change: { interactionMode: "default" }, code: "interaction_mode_escalation_denied" },
  { change: { projectId: ProjectId.make("other-project") }, code: "invalid_request" },
  {
    change: { linkOrigin: { sessionId: "other-link", label: "Other" } },
    code: "capability_denied",
  },
] as const)("a keyed launch rechecks the current thread for $code", ({ change, code }) =>
  Effect.gen(function* () {
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    let changedAt: "lookup" | "result" | undefined;
    const { projectId, dependencies } = clientLaunchHarness({
      launched,
      runtimeModeCeiling: "auto",
      client: { linked: true, narrowedTo: { runtimeMode: "auto", interactionMode: "plan" } },
      launchShell: (shell, read) => (read === changedAt ? { ...shell, ...change } : shell),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const request = toolkit
      .handle("t3_thread_launch", { projectId, title: "Test", clientRequestId: "launch-1" })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(dependencies),
        Effect.map((replies) => replies.at(-1)?.result),
      );

    const first = yield* request;
    expect(first).toMatchObject({ projectId });
    expect(yield* request).toEqual(first);
    changedAt = "lookup";
    expect(yield* request).toMatchObject({ code });
    expect(launched).toHaveLength(2);
    changedAt = "result";
    expect(yield* request).toMatchObject({ code });
    expect(launched).toHaveLength(3);
  }),
);

it.effect("a launch onto a usage-limited account fails before any thread exists", () =>
  Effect.gen(function* () {
    const claude = ProviderInstanceId.make("claudeAgent");
    const providers = [
      advertisedProvider("claudeAgent", ["claude-opus", "claude-sonnet"]),
      {
        ...advertisedProvider("claude_second", ["claude-opus", "claude-sonnet"]),
        driver: ProviderDriverKind.make("claudeAgent"),
      },
    ];
    const resetAt = "2026-11-04T06:33:00.000Z";
    const launch = Effect.fn("test.launch")(function* (params: {
      readonly auto?: true;
      readonly failover?: boolean;
    }) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "full-access",
        launched,
        providers,
        limited: new Map([[claude, [{ resetAt, refusedAt: "2026-11-03T00:00:00Z" }]]]),
        autoModeProvider: ProviderDriverKind.make("claudeAgent"),
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("claude_second")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
            },
          },
          failoverLimitedThreads: params.failover ?? false,
        },
      });
      return yield* Effect.gen(function* () {
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer)),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", {
            title: "Fix",
            projectId,
            message: "Fix the bug",
            ...(params.auto
              ? { auto: true }
              : { modelSelection: { instanceId: claude, model: "claude-opus" } }),
          })
          .pipe(Stream.unwrap, Stream.runCollect);
        return { result: result.at(-1)?.result, launched };
      }).pipe(Effect.provide(dependencies));
    });

    const named = yield* launch({});
    expect(named.result).toMatchObject({ code: "provider_unavailable" });
    expect((named.result as { message: string }).message).toContain(resetAt);
    expect(named.launched).toEqual([]);

    // Auto with account switching on starts on the account with room.
    expect((yield* launch({ auto: true, failover: true })).launched).toHaveLength(1);

    // Without switching, Auto would stay on the limited account, so it is refused too.
    const pinned = yield* launch({ auto: true, failover: false });
    expect(pinned.result).toMatchObject({ code: "provider_unavailable" });
    expect(pinned.launched).toEqual([]);
  }),
);

const forwardingCaller = () => {
  const parent = McpToolAccessTestkit.liveThreadShell(ThreadId.make("thread-parent"));
  const child = {
    ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("thread-child")),
    lineage: {
      rootThreadId: parent.id,
      parentThreadId: parent.id,
      relationshipToParent: "subagent" as const,
    },
  };
  const screenshot: ChatAttachment = {
    type: "image",
    id: ChatAttachmentId.make("thread-parent-00000000-0000-4000-8000-000000000001"),
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };
  const spec: ChatAttachment = {
    type: "file",
    id: ChatAttachmentId.make("thread-child-00000000-0000-4000-8000-000000000002-pdf"),
    name: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
  };
  return {
    screenshot,
    spec,
    callerThreads: [
      { shell: child, attachments: [spec] },
      { shell: parent, attachments: [screenshot] },
    ],
  };
};

it.effect(
  "a launch copies attachments from the caller's thread and the thread that delegated it",
  () => {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { screenshot, spec, callerThreads } = forwardingCaller();
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      callerThreads,
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const pathOf = (attachment: ChatAttachment) =>
        resolveAttachmentPath({ attachmentsDir, attachment }) ?? "";
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pathOf(screenshot), "png");
      yield* fileSystem.writeFileString(pathOf(spec), "%PDF");
      yield* fileSystem.writeFileString(`${pathOf(spec)}.txt`, "spec text");
      const upload: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("pending-00000000-0000-4000-8000-000000000003"),
        name: "upload.png",
        mimeType: "image/png",
        sizeBytes: 6,
      };
      yield* fileSystem.writeFileString(pathOf(upload), "upload");
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer)),
      );

      yield* toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug in the screenshot",
          attachments: [{ id: screenshot.id }, spec, upload],
        })
        .pipe(Stream.unwrap, Stream.runCollect);

      const [launch] = launched;
      const sent = launch?.initialMessage?.attachments ?? [];
      const segment = toSafeThreadAttachmentSegment(launch?.threadId ?? "");
      expect(sent.map(({ name }) => name)).toEqual(["screenshot.png", "spec.pdf", "upload.png"]);
      expect(sent.every(({ id }) => id.startsWith(`${segment}-`))).toBe(true);
      expect(
        yield* Effect.forEach(sent, (sent) => fileSystem.readFileString(pathOf(sent))),
      ).toEqual(["png", "%PDF", "upload"]);
      expect(yield* fileSystem.readFileString(`${pathOf(sent[1]!)}.txt`)).toBe("spec text");
      // The sources stay with their threads; the staged copies are gone.
      expect((yield* fileSystem.readDirectory(attachmentsDir)).toSorted()).toEqual(
        [
          ...[screenshot, spec, upload].map((attachment) => pathOf(attachment)),
          `${pathOf(spec)}.txt`,
          ...sent.map((attachment) => pathOf(attachment)),
          `${pathOf(sent[1]!)}.txt`,
        ]
          .map((path) => path.slice(attachmentsDir.length + 1))
          .toSorted(),
      );
    }).pipe(Effect.provide(dependencies));
  },
);

it.effect("a launch refuses an attachment from a thread the caller cannot see", () => {
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const { projectId, dependencies } = clientLaunchHarness({
    runtimeModeCeiling: "full-access",
    launched,
    callerThreads: forwardingCaller().callerThreads,
  });
  return Effect.gen(function* () {
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer)),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        attachments: [
          { id: ChatAttachmentId.make("thread-other-00000000-0000-4000-8000-000000000004") },
        ],
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toEqual([]);
  }).pipe(Effect.provide(dependencies));
});

it.effect("a launch key of any length or content gives a short id and never a defect", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string) =>
      toolkit
        .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    // Percent-encoding would grow this six times; scratch folders are named from the id.
    yield* launch("\u00e9".repeat(256));
    expect(launched.map((input) => input.commandId)).toEqual([
      expect.stringMatching(/^mcp:launch:[0-9a-f]{64}$/),
    ]);

    const loneSurrogate = yield* launch("key-\ud800").pipe(Effect.exit);
    expect(Exit.isFailure(loneSurrogate) && Cause.hasDies(loneSurrogate.cause)).toBe(false);
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a retried launch replays after the project loses its default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, projectDefaults, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId: "fix-1" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    projectDefaults.model = null;
    const retried = (yield* launch).at(-1)?.result;
    expect(retried).toMatchObject({ projectId, modelSelection });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Git registers resolved paths, and a launch keeps the registered one.
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" }),
    );
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    const alias = path.join(root, "alias");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string, clientRequestId?: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree, "existing-checkout")).at(-1)?.result).toMatchObject({
      projectId,
    });
    expect((yield* launchInto(outside, "existing-checkout")).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    // The thread keeps the registered worktree path when launched through a link to it.
    yield* Effect.promise(() => NodeFSP.symlink(worktree, alias, "junction"));
    expect((yield* launchInto(alias)).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
      { type: "existing_worktree", worktreePath: worktree },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef !== "main"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
                ...(workspaceStrategy.startFromOrigin === true
                  ? { lookup: "remotes-lack-commit", remoteNames: ["origin", "upstream"] }
                  : { lookup: "checkout", remoteNames: [] }),
              }),
            )
          : workspaceStrategy.type === "worktree" && workspaceStrategy.branch === "feature/taken"
            ? Effect.fail(
                new ThreadLaunch.ThreadLaunchBranchExistsError({
                  projectId,
                  projectTitle: "Client target",
                  branch: workspaceStrategy.branch,
                }),
              )
            : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string, startFromOrigin = false, branch?: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef,
            ...(branch === undefined ? {} : { branch }),
            startFromOrigin,
          },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toBe(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created. Pass a branch, tag, or commit that exists there, or set startFromOrigin:true if it exists only on a remote.',
    );
    // The refusal names what was asked, so the caller knows where the commit has to be.
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const unfetched = (yield* launchFrom(sha, true)).at(-1)?.result;
    expect((unfetched as { message: string }).message).toBe(
      `Base ref "${sha}" is not in project "Client target" (/projects/client-target), and none of its remotes (origin, upstream) has that commit. No thread was created. Push the commit to one of those remotes, or pass a branch, tag, or commit that exists there.`,
    );
    expect((yield* launchFrom("main", false, "feature/taken")).at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message:
        'Branch "feature/taken" already exists in project "Client target". No thread was created. Pass a branch name that does not exist yet, or omit branch to get a generated name.',
    });
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

it.effect(
  "a launch into a new worktree with no base starts from the project's default branch",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-default-base-" });
      const repo = path.join(root, "repo");
      const origin = path.join(root, "origin.git");
      yield* fileSystem.makeDirectory(repo);

      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        workspaceRoot: repo,
      });
      const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
      yield* git.execute({
        operation: "test.setupOrigin",
        cwd: root,
        args: ["init", "--bare", "--initial-branch=main", origin],
      });
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["remote", "add", "origin", origin],
        ["push", "origin", "main"],
      ]) {
        yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
      }
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const launchInto = (workspaceStrategy: { type: "worktree"; startFromOrigin?: boolean }) =>
        toolkit
          .handle("t3_thread_launch", { title: "Fix", projectId, workspaceStrategy })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

      yield* launchInto({ type: "worktree" });
      yield* launchInto({ type: "worktree", startFromOrigin: false });
      expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
        { type: "worktree", baseRef: "refs/remotes/origin/HEAD", startFromOrigin: true },
        { type: "worktree", baseRef: "main", startFromOrigin: false },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a worktree launch that omits startFromOrigin follows the new-worktree setting", () =>
  Effect.gen(function* () {
    const cases = [
      { setting: true, given: undefined, expected: true },
      { setting: false, given: undefined, expected: false },
      { setting: true, given: false, expected: false },
    ];
    for (const { setting, given, expected } of cases) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const checked: Array<ThreadLaunch.ThreadLaunchInput["workspaceStrategy"]> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        newWorktreesStartFromOrigin: setting,
        checkWorktreeBase: ({ workspaceStrategy }) =>
          Effect.sync(() => {
            checked.push(workspaceStrategy);
          }),
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      yield* toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: "main",
            ...(given === undefined ? {} : { startFromOrigin: given }),
          },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

      const strategy = { type: "worktree", baseRef: "main", startFromOrigin: expected };
      expect(checked).toEqual([strategy]);
      expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([strategy]);
    }
  }),
);

it.effect("a launch that omits its workspace follows the new-threads-in-a-worktree default", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const source of ["setting", "t3.json"] as const) {
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-env-mode-" });
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        workspaceRoot: repo,
        ...(source === "setting" ? { defaultThreadEnvMode: "worktree" as const } : {}),
      });
      const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ]) {
        yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
      }
      if (source === "t3.json")
        yield* fileSystem.writeFileString(
          `${repo}/t3.json`,
          JSON.stringify({ defaultThreadEnvMode: "worktree" }),
        );
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      for (const workspaceStrategy of [undefined, { type: "root" as const }]) {
        yield* toolkit
          .handle("t3_thread_launch", {
            title: "Fix",
            projectId,
            ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      }

      expect(
        launched.map((launch) => launch.workspaceStrategy.type),
        source,
      ).toEqual(["worktree", "root"]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a defaulted worktree launch stays shared only when Git says HEAD has no commit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const commitArgs = ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty"];
    for (const [checkout, expected] of [
      ["not a repository", "root"],
      ["no commit yet", "root"],
      ["branch tip object missing", "worktree"],
      ["git refuses the repository", "refused"],
    ] as const) {
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-head-" });
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        workspaceRoot: repo,
        defaultThreadEnvMode: "worktree",
      });
      const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
      if (checkout !== "not a repository")
        yield* git.execute({
          operation: "test.setupRepo",
          cwd: repo,
          args: ["init", "-b", "main"],
        });
      if (checkout === "branch tip object missing")
        yield* fileSystem.writeFileString(`${repo}/.git/refs/heads/main`, `${"1".repeat(40)}\n`);
      if (checkout === "git refuses the repository") {
        yield* git.execute({
          operation: "test.setupRepo",
          cwd: repo,
          args: [...commitArgs, "-m", "init"],
        });
        // Git quotes the broken file's path in its refusal; that path must not read as "not a repository".
        yield* fileSystem.writeFileString(`${repo}/not a git repository`, "[core\n");
        yield* fileSystem.writeFileString(
          `${repo}/.git/config`,
          `[include]\n\tpath = ${repo}/not a git repository\n`,
        );
      }
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = (yield* toolkit
        .handle("t3_thread_launch", { title: "Fix", projectId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies))).at(-1)?.result;

      if (expected === "refused") {
        expect(result, checkout).toMatchObject({ code: "orchestration_error" });
        expect(launched, checkout).toHaveLength(0);
      } else {
        expect(
          launched.map((launch) => launch.workspaceStrategy.type),
          checkout,
        ).toEqual([expected]);
      }
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its branch collides", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        Effect.fail(
          new ThreadLaunch.ThreadLaunchBranchConflictError({
            projectId,
            projectTitle: "Client target",
            branch: workspaceStrategy.branch ?? "",
            conflictingBranch: "werkstatt",
          }),
        ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const refused = (yield* toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "werkstatt/baseline" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies))).at(-1)?.result;

    expect(refused).toMatchObject({
      code: "invalid_request",
      message:
        'Branch "werkstatt/baseline" cannot be created in project "Client target": branch "werkstatt" exists. No thread was created. Use a name that does not nest under or contain an existing branch, such as "werkstatt-baseline".',
    });
    expect(launched).toHaveLength(0);
  }),
);

it.effect("a launch into an unknown project says the project was not found", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    for (const workspaceStrategy of [
      undefined,
      { type: "worktree", baseRef: "main", startFromOrigin: false } as const,
    ]) {
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          message: "Fix the bug",
          projectId: ProjectId.make("current"),
          modelSelection,
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(result.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        message: "The project was not found.",
      });
    }
    expect(launched).toHaveLength(0);
  }),
);

it.effect("a retried worktree launch replays after its base ref is gone", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const base = { exists: true };
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        base.exists || workspaceStrategy.type !== "worktree"
          ? Effect.void
          : Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
                lookup: "checkout",
                remoteNames: [],
              }),
            ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        clientRequestId: "fix-worktree",
        workspaceStrategy: { type: "worktree", baseRef: "feature", startFromOrigin: false },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    base.exists = false;
    expect((yield* launch).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a client launches with the fallback for an exhausted default", () =>
  Effect.gen(function* () {
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const fallbackModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
    const providers: ServerProvider[] = ["claudeAgent", "codex"].map((driver) => ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...(driver === "claudeAgent"
        ? {
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00Z",
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
            },
          }
        : {}),
    }));
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      fallbackModel,
      providers,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        projectId,
        title: "Fallback",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({
      modelSelection: fallbackModel,
    });
    expect(launched[0]?.modelSelection).toEqual(fallbackModel);
  }),
);

it.effect("creating a project through MCP refuses a model default instead of dropping it", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        create: () => Effect.die("the project was created without its model default"),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_create", {
        title: "client-target",
        workspaceRoot: "/projects/client-target",
        defaultModelSelection: harness.modelSelection,
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(refused.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("t3_project_update"),
    });
  }),
);

it.effect("an agent's clone is not cut off while git is still transferring", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-clone-" });
    const destinationPath = path.join(parent, "repo");
    const started = yield* Deferred.make<void>();
    const transferred = yield* Deferred.make<void>();
    const { dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched: [],
    });
    const repositories = Repositories.layer.pipe(
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          invalidateRefs: () => Effect.void,
          // Like the real driver, the clone fails once it outlives the deadline it was given.
          execute: (input) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(transferred)),
              Effect.as({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
              Effect.timeoutOrElse({
                duration: input.timeoutMs ?? Infinity,
                orElse: () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: input.operation,
                      command: "git",
                      cwd: input.cwd,
                      detail: "Git command timed out.",
                    }),
                  ),
              }),
            ),
        }),
      ),
      Layer.provideMerge(dependencies),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(repositories)),
      ),
    );

    const clone = yield* toolkit
      .handle("t3_project_clone", { remoteUrl: "https://example.test/repo.git", destinationPath })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(repositories), Effect.forkChild);
    yield* Deferred.await(started);
    // A large repository over a slow link; agents' MCP calls get a far longer budget.
    yield* TestClock.adjust("10 minutes");
    yield* Deferred.succeed(transferred, undefined);

    expect((yield* Fiber.join(clone)).at(-1)?.result).toMatchObject({ cwd: destinationPath });
  }).pipe(Effect.provide(NodeServices.layer)),
);

const deletedProject = (id: ProjectId) => ({
  id,
  title: "client-target",
  workspaceRoot: "/projects/client-target",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: "2026-01-01T00:00:00.000Z",
});

it.effect("deleting a project through MCP also discards its clone record", () =>
  Effect.gen(function* () {
    const discarded: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(Project.ProjectService)({
          delete: (input) => Effect.succeed(deletedProject(input.projectId)),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          discard: (projectId) => Effect.sync(() => void discarded.push(projectId)),
        }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(discarded).toEqual([harness.projectId]);
  }),
);

it.effect("an agent cannot delete the built-in scratch project, even with force", () =>
  Effect.gen(function* () {
    const deleted: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: (projectId) => Effect.succeed(projectId === harness.projectId),
        }),
        Layer.mock(Project.ProjectService)({
          delete: (input) =>
            Effect.sync(() => {
              deleted.push(input.projectId);
              return deletedProject(input.projectId);
            }),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId, force: true })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(deleted).toEqual([]);
    expect(refused.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/scratch|no project/i),
    });
  }),
);

it.effect("reading a project shows the default model and actions saved in Settings", () =>
  Effect.gen(function* () {
    const overrideModel = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet",
    };
    const overrideScripts = [
      { id: "test", name: "Test", command: "pnpm test", icon: "test", runOnWorktreeCreate: false },
    ] satisfies ProjectScript[];
    const harness = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      overrideModel,
      overrideScripts,
      launched: [],
    });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        getById: (projectId) =>
          Effect.succeedSome({
            id: projectId,
            title: "Client target",
            workspaceRoot: "/projects/client-target",
            defaultModelSelection: null,
            scripts: [
              {
                id: "stale",
                name: "Stale",
                command: "true",
                icon: "play",
                runOnWorktreeCreate: false,
              },
            ],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const read = yield* toolkit
      .handle("t3_project_read", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(read.at(-1)?.result).toMatchObject({
      defaultModelSelection: overrideModel,
      scripts: overrideScripts,
    });
  }),
);

it.effect("a project update or create that is refused tells the agent why", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const detail = "Project monograms must contain at most two characters.";
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        update: (input) =>
          Effect.fail(new Project.ProjectInvalidError({ projectId: input.projectId, detail })),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_update", {
        projectId: harness.projectId,
        projectIcon: { kind: "monogram", text: "ABC", color: "blue" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request", message: detail });

    // A project started from its title has no folder yet for tracked folders to be checked against.
    const dropped = yield* toolkit
      .handle("t3_project_create", {
        title: "Wrapper",
        trackedFolders: [{ path: "/repos/api", name: "api" }],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(dropped.at(-1)?.result).toMatchObject({ code: "invalid_request" });
  }),
);
