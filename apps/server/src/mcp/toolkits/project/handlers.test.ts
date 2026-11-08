import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
  type ChatAttachment,
  ChatAttachmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DocumentText from "../../../provider/DocumentText.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as AccountRouting from "../../../orchestration-v2/AccountRouting.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
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

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly fallbackModel?: ModelSelection;
  readonly providers?: readonly ServerProvider[];
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  readonly webOrigin?: string;
  /** The orchestrator refuses the new thread's mode, as under a managed ceiling. */
  readonly refusedByCeiling?: true;
  readonly autoModeProvider?: ProviderDriverKind;
  /** Accounts a usage limit stopped, with their resets. */
  readonly limited?: ReadonlyMap<ProviderInstanceId, ProjectionStore.RecordedUsageLimit>;
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
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    NodeCrypto.layer,
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
              webOrigin: input.webOrigin,
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
        return Effect.succeed(
          launch === undefined
            ? null
            : ({
                id: launch.threadId,
                projectId: launch.projectId,
                modelSelection: launch.modelSelection,
                deletedAt: null,
              } as unknown as OrchestrationV2ThreadShell),
        );
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
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
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
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(
        input.providers ?? [
          advertisedProvider("claudeAgent", ["claude-opus", "claude-sonnet"], {
            "claude-opus": ["opus"],
          }),
          advertisedProvider("codex", ["gpt-settings"]),
        ],
      ),
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getUsageLimitedProviderInstances: () => Effect.succeed(input.limited ?? new Map()),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
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
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
          readonly webOrigin?: string;
          readonly refusedByCeiling?: true;
        },
      ) {
        const { targeted, overrideModel, webOrigin, refusedByCeiling, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
          ...(webOrigin === undefined ? {} : { webOrigin }),
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
        link: `<t3-thread://v2/environment/${belowCeiling.launched[0]?.threadId}>`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", {
        title: "Fix",
        webOrigin: "https://box.example.ts.net",
      });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");
      expect(aboveCeiling.result).toMatchObject({
        link: `https://box.example.ts.net/environment/${encodeURIComponent(aboveCeiling.launched[0]?.threadId ?? "")}`,
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

it.effect("a launch with a model its provider does not advertise creates no thread", () =>
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
    const launchWith = (instanceId: string, model: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug",
          modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
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
        message: `Model ${model} is not advertised by provider ${instanceId}.`,
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

      for (const refused of [
        yield* launchWith(undefined, { auto: true }),
        yield* launchWith(claude, {
          auto: true,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-settings" },
        }),
      ]) {
        expect(refused.result).toMatchObject({ code: "invalid_request" });
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
        limited: new Map([[claude, { resetAt, refusedAt: "2026-11-03T00:00:00Z" }]]),
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
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
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
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
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
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
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
        args: ["init", "--bare", origin],
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
        { type: "worktree", baseRef: "origin/main", startFromOrigin: true },
        { type: "worktree", baseRef: "origin/main", startFromOrigin: false },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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

it.effect("deleting a project through MCP also discards its clone record", () =>
  Effect.gen(function* () {
    const discarded: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(Project.ProjectService)({
          delete: (input) =>
            Effect.succeed({
              id: input.projectId,
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
            }),
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
