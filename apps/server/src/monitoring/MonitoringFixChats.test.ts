import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type MonitoringFinding,
  type MonitoringFixChatInput,
  type MonitoringThreadSummary,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type T3ProjectFile,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MonitoringFixChats from "./MonitoringFixChats.ts";
import * as Monitoring from "./MonitoringService.ts";

const MINUTE = 60_000;
const scratchProjectId = ProjectId.make("project:scratch");
const app = ProjectId.make("project:app");
const site = ProjectId.make("project:site");
const instanceId = ProviderInstanceId.make("claude");
const claude = ProviderDriverKind.make("claudeAgent");

const provider: ServerProvider = {
  instanceId,
  driver: claude,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-11T11:59:00.000Z",
  models: [{ slug: "large", name: "Large", isCustom: false, isDefault: true, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const slowCommand = (wastedMs: number, detail: string): MonitoringFinding => ({
  code: "slow_command",
  severity: "high",
  wastedMs,
  count: 2,
  detail,
});

// The service reads only these fields of a summary.
const chat = (
  id: string,
  projectId: ProjectId,
  findings: ReadonlyArray<MonitoringFinding>,
): MonitoringThreadSummary =>
  ({
    threadId: ThreadId.make(id),
    projectId,
    title: `Chat ${id}`,
    settledAt: "2026-11-19T12:00:00.000Z",
    findings,
  }) as unknown as MonitoringThreadSummary;

const chats = [
  chat("thread:a", app, [
    slowCommand(30 * MINUTE, "TOKEN=sk-ant-abcdefghijklmnopqrstuvwxyz0123 vp run test"),
  ]),
  chat("thread:b", site, [slowCommand(45 * MINUTE, "vp run build")]),
  chat("thread:c", site, [slowCommand(10 * MINUTE, "vp run lint")]),
  chat("thread:d", app, [
    { code: "retries", severity: "low", wastedMs: 0, count: 1, detail: null },
  ]),
];

const input: MonitoringFixChatInput = {
  commandId: CommandId.make("command:fix"),
  creationSource: "mobile",
  code: "slow_command",
  projectId: site,
  threadIds: chats.map((summary) => summary.threadId),
};

const projectRecord = (id: ProjectId, title: string) =>
  ({ id, title, workspaceRoot: `/projects/${title}` }) as ProjectRecord;

interface Setup {
  readonly existingProjects: ReadonlyArray<ProjectRecord>;
  /** Chats that already exist, such as one an earlier attempt of the same request started. */
  readonly existingChats?: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly latestUserMessageAt: string | null;
  }>;
  readonly settings?: Partial<ServerSettingsValue>;
  /** Every project's t3.json. */
  readonly projectFile?: T3ProjectFile;
  /** Whether the projects are git repositories. */
  readonly repositories?: boolean;
}

const layerFor = (
  { existingProjects, existingChats = [], settings = {}, projectFile, repositories = true }: Setup,
  launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>,
) =>
  MonitoringFixChats.layer.pipe(
    Layer.provide(
      Layer.mock(Monitoring.MonitoringService)({
        summaries: (threadIds) =>
          Effect.succeed(chats.filter((summary) => threadIds.includes(summary.threadId))),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
    ),
    Layer.provide(
      Layer.mock(Project.ProjectService)({
        getById: (projectId) =>
          Effect.succeed(
            Option.fromNullishOr(existingProjects.find((project) => project.id === projectId)),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => {
          const existing = existingChats.find((candidate) => candidate.id === threadId);
          return Effect.succeed(
            existing === undefined
              ? null
              : ({
                  ...existing,
                  deletedAt: null,
                  modelSelection: { instanceId, model: "large" },
                } as unknown as OrchestrationV2ThreadShell),
          );
        },
      }),
    ),
    Layer.provide(
      Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
        load: () => Effect.succeed(Option.fromNullishOr(projectFile)),
      }),
    ),
    // A repository's remote's default branch is main.
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetailsLocal: () =>
          Effect.succeed({ isRepo: repositories } as GitVcsDriver.GitStatusDetails),
        resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        resolveDefaultBranchName: () => Effect.succeed("main"),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (request) =>
          Ref.update(launches, (seen) => [...seen, request]).pipe(
            Effect.as({
              threadId: ThreadId.make("thread:fix"),
              resumed: false,
            } as ThreadLaunch.ThreadLaunchResult),
          ),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: claude } },
        ...settings,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const start = (setup: Setup, request: MonitoringFixChatInput = input) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const result = yield* MonitoringFixChats.MonitoringFixChats.pipe(
      Effect.flatMap((service) => service.start(request)),
      Effect.provide(layerFor(setup, launches).pipe(Layer.orDie)),
      Effect.result,
    );
    return { result, launches: yield* Ref.get(launches) };
  });

describe("MonitoringFixChats", () => {
  it.effect("starts a chat that lists every chat with the weak point, most time lost first", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start({
        existingProjects: [
          projectRecord(app, "App ghp_abcdefghijklmnopqrstuvwxyz0123"),
          projectRecord(site, "Site"),
        ],
      });
      expect(result).toMatchObject({ _tag: "Success", success: { threadId: "thread:fix" } });
      expect(launches).toHaveLength(1);
      const [launch] = launches;
      expect(launch).toMatchObject({
        commandId: input.commandId,
        threadId: input.commandId,
        projectId: site,
        title: "Fix weak point: Slow commands",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "mobile",
      });
      const text = launch?.initialMessage?.text ?? "";
      expect(text).toContain("Weak point: Slow commands");
      expect(text).toContain("What it means: Single commands ran 10 minutes or more.");
      expect(text).toContain("Chats it hit (3 chats, 1h 25m lost in all), most time lost first:");
      const lines = text.split("\n").filter((line) => line.startsWith("- "));
      expect(lines).toEqual([
        '- "Chat thread:b" (thread thread:b, project Site, settled 2026-11-19): 2 slow commands; 45m lost; slowest command: vp run build',
        '- "Chat thread:a" (thread thread:a, project App [redacted], settled 2026-11-19): 2 slow commands; 30m lost; slowest command: TOKEN=[redacted] vp run test',
        '- "Chat thread:c" (thread thread:c, project Site, settled 2026-11-19): 2 slow commands; 10m lost; slowest command: vp run lint',
      ]);
    }),
  );

  it.effect("starts in No project when the chosen project is gone", () =>
    Effect.gen(function* () {
      const { launches } = yield* start({ existingProjects: [projectRecord(app, "App")] });
      expect(launches[0]?.projectId).toBe(scratchProjectId);
    }),
  );

  it.effect.each([
    ["the settings", { settings: { defaultThreadEnvMode: "worktree" } }],
    ["the project's t3.json", { projectFile: { defaultThreadEnvMode: "worktree" } }],
  ] as const)("starts in a worktree from the default branch when %s pick worktrees", ([, setup]) =>
    Effect.gen(function* () {
      const { result, launches } = yield* start({
        existingProjects: [projectRecord(site, "Site")],
        ...setup,
      });
      expect(result).toMatchObject({ success: { workspaceStrategy: "worktree" } });
      expect(launches[0]?.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: "origin/main",
        startFromOrigin: true,
      });
    }),
  );

  it.effect("starts in the folder when a project set to worktrees is not a repository", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start({
        existingProjects: [projectRecord(site, "Site")],
        projectFile: { defaultThreadEnvMode: "worktree" },
        repositories: false,
      });
      expect(result).toMatchObject({ success: { workspaceStrategy: "root" } });
      expect(launches[0]?.workspaceStrategy).toEqual({ type: "root" });
    }),
  );

  it.effect("fails without starting a chat when no chat still shows the weak point", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start(
        { existingProjects: [projectRecord(app, "App")] },
        { ...input, code: "usage_limit" },
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "no-chats" } });
      expect(launches).toEqual([]);
    }),
  );

  it.effect.each([
    [
      "opens it once its first message went in",
      true,
      { _tag: "Success", success: { threadId: input.commandId, resumed: true } },
    ],
    [
      "fails while its first message is missing",
      false,
      { _tag: "Failure", failure: { reason: "no-chats" } },
    ],
  ] as const)(
    "a retry of a chat a lost answer started, once its chats no longer qualify, %s",
    ([, messageAccepted, expected]) =>
      Effect.gen(function* () {
        const { result, launches } = yield* start(
          {
            existingProjects: [projectRecord(app, "App")],
            existingChats: [
              {
                id: ThreadId.make(input.commandId),
                projectId: app,
                latestUserMessageAt: messageAccepted ? "2026-11-19T12:05:00.000Z" : null,
              },
            ],
          },
          { ...input, code: "usage_limit" },
        );
        expect(result).toMatchObject(expected);
        expect(launches).toEqual([]);
      }),
  );
});
