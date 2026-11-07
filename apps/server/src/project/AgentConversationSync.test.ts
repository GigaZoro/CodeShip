import { expect, it } from "@effect/vitest";
import {
  AgentSessionImportProjectNotFoundError,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationProjectShell,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as AgentConversationSync from "./AgentConversationSync.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const timestamp = "2026-10-01T00:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const shell = (id: ProjectId): OrchestrationProjectShell => ({
  id,
  title: id,
  workspaceRoot: `/work/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

const projectCreated = (id: ProjectId): ApplicationStoredEvent => ({
  sequence: 1,
  eventId: EventId.make(`created:${id}`),
  aggregateKind: "project",
  aggregateId: id,
  occurredAt: timestamp,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.created",
  payload: { ...shell(id), projectId: id },
});

interface Created {
  readonly count: number;
  readonly latest: { readonly threadId: ThreadId; readonly updatedAt: string };
}

const startSync = Effect.fn(function* (
  initial: Partial<ServerSettings>,
  importer: {
    // What each project's first import creates; later imports find everything already imported.
    readonly created?: Partial<Record<ProjectId, Created>>;
    readonly failing?: ReadonlyArray<ProjectId>;
  } = {},
) {
  const settings = yield* Ref.make<ServerSettings>({ ...DEFAULT_SERVER_SETTINGS, ...initial });
  const settingsChanges = yield* Queue.unbounded<ServerSettings>();
  const projects = yield* Ref.make([shell(projectA), shell(projectB)]);
  const projectEvents = yield* Queue.unbounded<ApplicationStoredEvent>();
  const imports = yield* Queue.unbounded<ProjectId>();
  const importedBefore = yield* Ref.make(new Set<ProjectId>());
  const context = yield* Layer.build(
    AgentConversationSync.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Ref.get(settings),
            subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
          }),
          Layer.mock(ProjectService.ProjectService)({
            listShells: () => Ref.get(projects),
          }),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({ refresh: Effect.void }),
          Layer.mock(AgentSessionImporter.AgentSessionImporter)({
            importAllAgentThreads: Effect.fn(function* (projectId) {
              yield* Queue.offer(imports, projectId);
              if (importer.failing?.includes(projectId)) {
                return yield* new AgentSessionImportProjectNotFoundError({ projectId });
              }
              const first = !(yield* Ref.getAndUpdate(
                importedBefore,
                (seen) => new Set([...seen, projectId]),
              )).has(projectId);
              const created = first ? importer.created?.[projectId] : undefined;
              return {
                importedCount: 1,
                skippedCount: 0,
                createdCount: created?.count ?? 0,
                latestCreated: created?.latest ?? null,
              };
            }),
          }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            latestApplicationSequence: Effect.succeed(0),
            streamApplicationEvents: () => Stream.fromQueue(projectEvents),
          }),
        ),
      ),
    ),
  );
  const service = Context.get(context, AgentConversationSync.AgentConversationSync);
  return {
    importedSinceSettingsChange: service.importedSinceSettingsChange(),
    nextImport: Queue.take(imports),
    changeSettings: (patch: Partial<ServerSettings>) =>
      Ref.updateAndGet(settings, (current) => ({ ...current, ...patch })).pipe(
        Effect.flatMap((next) => Queue.offer(settingsChanges, next)),
      ),
    addProject: (id: ProjectId) =>
      Ref.update(projects, (current) => [...current, shell(id)]).pipe(
        Effect.andThen(Queue.offer(projectEvents, projectCreated(id))),
      ),
  };
});

it.effect("imports enabled projects at startup and the rest once the device setting turns on", () =>
  Effect.gen(function* () {
    const sync = yield* startSync({
      projectSettingsOverrides: { [projectA]: { importAgentConversations: true } },
    });
    expect(yield* sync.nextImport).toBe(projectA);

    yield* sync.changeSettings({ importAgentConversations: true });
    expect([yield* sync.nextImport, yield* sync.nextImport]).toEqual([projectA, projectB]);
  }).pipe(Effect.scoped),
);

it.effect("imports a project's history as soon as the project is added", () =>
  Effect.gen(function* () {
    const projectC = ProjectId.make("project-c");
    const sync = yield* startSync({
      importAgentConversations: true,
      projectSettingsOverrides: { [projectB]: { importAgentConversations: false } },
    });
    expect(yield* sync.nextImport).toBe(projectA);

    yield* sync.addProject(projectC);
    expect([yield* sync.nextImport, yield* sync.nextImport]).toEqual([projectA, projectC]);
  }).pipe(Effect.scoped),
);

const createdA: Created = {
  count: 2,
  latest: { threadId: ThreadId.make("import-a"), updatedAt: "2026-10-02T00:00:00.000Z" },
};
const createdB: Created = {
  count: 1,
  latest: { threadId: ThreadId.make("import-b"), updatedAt: "2026-10-03T00:00:00.000Z" },
};

it.effect("reports what turning the import on brought in, after its own sync already ran", () =>
  Effect.gen(function* () {
    const sync = yield* startSync({}, { created: { [projectA]: createdA, [projectB]: createdB } });

    yield* sync.changeSettings({ importAgentConversations: true });
    expect([yield* sync.nextImport, yield* sync.nextImport]).toEqual([projectA, projectB]);
    expect(yield* sync.importedSinceSettingsChange).toEqual({
      importedCount: 3,
      latestThread: createdB.latest,
      complete: true,
    });
  }).pipe(Effect.scoped),
);

it.effect("counts again from zero when the import settings change", () =>
  Effect.gen(function* () {
    const sync = yield* startSync(
      { importAgentConversations: true },
      { created: { [projectA]: createdA } },
    );
    expect([yield* sync.nextImport, yield* sync.nextImport]).toEqual([projectA, projectB]);

    yield* sync.changeSettings({ importAgentConversations: false });
    yield* sync.changeSettings({ importAgentConversations: true });
    expect(yield* sync.importedSinceSettingsChange).toEqual({
      importedCount: 0,
      latestThread: null,
      complete: true,
    });
  }).pipe(Effect.scoped),
);

it.effect("marks the report incomplete when a project's import fails", () =>
  Effect.gen(function* () {
    const sync = yield* startSync({}, { created: { [projectB]: createdB }, failing: [projectA] });

    yield* sync.changeSettings({ importAgentConversations: true });
    expect(yield* sync.importedSinceSettingsChange).toEqual({
      importedCount: 1,
      latestThread: createdB.latest,
      complete: false,
    });
  }).pipe(Effect.scoped),
);
