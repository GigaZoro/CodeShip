import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type MonitoringFinding,
  type MonitoringFixChatInput,
  type MonitoringThreadSummary,
  type Project as ProjectRecord,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
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
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  chat("thread:a", app, [slowCommand(30 * MINUTE, "vp run test")]),
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
  threadIds: chats.map((summary) => summary.threadId),
};

const projectRecord = (id: ProjectId, title: string) => ({ id, title }) as ProjectRecord;

const layerFor = (
  existingProjects: ReadonlyArray<ProjectRecord>,
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
        getThreadShell: () => Effect.succeed(null),
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
      ServerSettings.layerTest({ providerInstances: { [instanceId]: { driver: claude } } }),
    ),
    Layer.provide(NodeServices.layer),
  );

const start = (
  existingProjects: ReadonlyArray<ProjectRecord>,
  request: MonitoringFixChatInput = input,
) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const result = yield* MonitoringFixChats.MonitoringFixChats.pipe(
      Effect.flatMap((service) => service.start(request)),
      Effect.provide(layerFor(existingProjects, launches).pipe(Layer.orDie)),
      Effect.result,
    );
    return { result, launches: yield* Ref.get(launches) };
  });

describe("MonitoringFixChats", () => {
  it.effect("starts a chat that lists every chat with the weak point, most time lost first", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([
        projectRecord(app, "App"),
        projectRecord(site, "Site"),
      ]);
      expect(result).toMatchObject({ _tag: "Success", success: { threadId: "thread:fix" } });
      expect(launches).toHaveLength(1);
      const [launch] = launches;
      expect(launch).toMatchObject({
        commandId: input.commandId,
        threadId: input.commandId,
        title: "Fix weak point: Slow commands",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "mobile",
      });
      const text = launch?.initialMessage?.text ?? "";
      expect(text).toContain("Weak point: Slow commands");
      expect(text).toContain("What it means: Single commands ran 10 minutes or more.");
      expect(text).toContain("Found in: 3 chats, 1h 25m lost in all");
      const lines = text.split("\n").filter((line) => line.startsWith("- "));
      expect(lines).toEqual([
        '- "Chat thread:b" (thread thread:b, project Site, settled 2026-11-19): 2 slow commands; 45m lost; slowest command: vp run build',
        '- "Chat thread:a" (thread thread:a, project App, settled 2026-11-19): 2 slow commands; 30m lost; slowest command: vp run test',
        '- "Chat thread:c" (thread thread:c, project Site, settled 2026-11-19): 2 slow commands; 10m lost; slowest command: vp run lint',
      ]);
    }),
  );

  it.effect.each([
    [
      "the project that lost the most time",
      [projectRecord(app, "App"), projectRecord(site, "Site")],
      site,
    ],
    ["the next project when that one is gone", [projectRecord(app, "App")], app],
    ["No project when every project is gone", [], scratchProjectId],
  ] as const)("starts in %s", ([, existingProjects, projectId]) =>
    Effect.gen(function* () {
      const { launches } = yield* start(existingProjects);
      expect(launches[0]?.projectId).toBe(projectId);
    }),
  );

  it.effect("fails without starting a chat when no chat still shows the weak point", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([projectRecord(app, "App")], {
        ...input,
        code: "usage_limit",
      });
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "no-chats" } });
      expect(launches).toEqual([]);
    }),
  );
});
