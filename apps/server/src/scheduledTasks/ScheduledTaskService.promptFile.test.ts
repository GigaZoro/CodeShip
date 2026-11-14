import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type MemoryShortage,
  type ScheduledTask,
  ScheduledTaskApplySharedInput,
  type ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as NetworkRecoveryWorker from "../orchestration-v2/NetworkRecoveryWorker.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PromptFileReader from "./PromptFileReader.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { layerSharedTaskDependencies, type TestSharedProject } from "./sharedTaskTestLayers.ts";

const PATH = "automations/daily.md";
const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const project: TestSharedProject = {
  id: "project-repo",
  title: "Repo",
  workspaceRoot: "/work/repo",
  canonicalKey: "github.com/acme/repo",
};

const decodeUpsert = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const decodeApply = Schema.decodeUnknownSync(ScheduledTaskApplySharedInput);

const upsertInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsert({
    id: "scheduled-task:file",
    title: "Daily",
    promptFile: PATH,
    // Off, so only Run now starts runs and the clock can move.
    enabled: false,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: project.id,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

const sharedCopy = (at: string, overrides: Record<string, unknown> = {}) =>
  decodeApply({
    type: "upsert",
    task: {
      id: "scheduled-task:copy",
      title: "Daily",
      prompt: "The text the other machine read.",
      promptFile: PATH,
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      followsDefaultModel: false,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-09-01T00:00:00.000Z",
      shared: {
        revision: { at, environmentId: "environment-other" },
        project: { type: "repository", canonicalKey: project.canonicalKey, title: project.title },
        excludedEnvironmentIds: [],
      },
      ...overrides,
    },
  });

/** Keeps whatever reaches it waiting until the test releases it. */
interface Hold {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const makeHold = Effect.all({ reached: Deferred.make<void>(), release: Deferred.make<void>() });

const waitAt = (hold: Hold | undefined) =>
  hold === undefined
    ? Effect.void
    : Deferred.succeed(hold.reached, undefined).pipe(Effect.andThen(Deferred.await(hold.release)));

/**
 * The tip of the default branch: what a push changes. `null` is a file that is not there, and a
 * hold keeps a read from answering until it is released. `lostConnection` fails reads as Git
 * does while the network is down.
 */
type Remote = Ref.Ref<{
  readonly text: string | null;
  readonly commit: string;
  readonly hold?: Hold;
  readonly lostConnection?: boolean;
}>;

const LOST_DETAIL =
  "could not fetch it: Git got no answer in time. Phases: credential helper git-credential-osxkeychain get still running after 60.0 s; transfer 0.0 s.";

/** What the network probe answers, and each answer it gave, so a test can move the clock after it. */
interface Network {
  readonly online: Ref.Ref<boolean>;
  readonly probed: Queue.Queue<boolean>;
}

interface Harness {
  readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
  readonly remote: Remote;
  readonly launched: Ref.Ref<ReadonlyArray<string>>;
  readonly network: Network;
  /** What this machine's memory reads; it never reads short unless a test sets it. */
  readonly memory: Ref.Ref<MemoryShortage | null>;
  /** Holds a save of a worktree task after it has loaded the stored task. */
  readonly saveHold: Ref.Ref<Hold | undefined>;
  /** One pass of the scheduler over the due tasks. */
  readonly poll: Effect.Effect<void>;
  /** Watches the list from now on; the effect it returns waits until the task matches. */
  readonly whenTask: (
    id: string,
    matches: (task: ScheduledTask) => boolean,
  ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
}

const withService = <A, E>(body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const remote: Remote = yield* Ref.make({
      text: "Run the daily check." as string | null,
      commit: "c1",
    });
    const launched = yield* Ref.make<ReadonlyArray<string>>([]);
    const network: Network = {
      online: yield* Ref.make(true),
      probed: yield* Queue.unbounded<boolean>(),
    };
    const saveHold = yield* Ref.make<Hold | undefined>(undefined);
    const memory = yield* Ref.make<MemoryShortage | null>(null);
    const workers = new Map<string, Effect.Effect<void>>();
    const reader = Layer.mock(PromptFileReader.PromptFileReader)({
      read: ({ cwd, path }) =>
        Effect.gen(function* () {
          const { text, commit, hold, lostConnection = false } = yield* Ref.get(remote);
          yield* waitAt(hold);
          if (lostConnection) {
            return yield* new PromptFileReader.PromptFileReadError({
              path,
              ref: "origin/main",
              detail: LOST_DETAIL,
              lostConnection,
            });
          }
          if (cwd === project.workspaceRoot && path === PATH && text !== null) {
            return { text, ref: "origin/main", commit };
          }
          return yield* new PromptFileReader.PromptFileReadError({
            path,
            ref: "origin/main",
            detail: "it does not exist there.",
            lostConnection: false,
          });
        }),
    });
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, {
            register: <E2, R>(name: string, work: Effect.Effect<void, E2, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
              }),
          }),
          ServerSettings.layerTest(),
          Layer.mock(MemoryAdmission.MemoryAdmission)({ shortage: Ref.get(memory) }),
          ManagedPolicy.layerTest(),
          Layer.succeed(
            NetworkRecoveryWorker.NetworkProbe,
            Ref.get(network.online).pipe(
              Effect.tap((online) => Queue.offer(network.probed, online)),
            ),
          ),
          layerSharedTaskDependencies([project], undefined, undefined, reader),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Ref.update(launched, (texts) => [...texts, input.initialMessage?.text ?? ""]).pipe(
                Effect.as({ threadId: ThreadId.make(`thread:run-${input.commandId}`) } as never),
              ),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            // Saves of a worktree task ask this after they load the stored task.
            isScratchProject: () =>
              Ref.get(saveHold).pipe(Effect.flatMap(waitAt), Effect.as(false)),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({
        service,
        remote,
        launched,
        network,
        memory,
        saveHold,
        poll: Effect.suspend(() => workers.get("scheduled-tasks")!),
        whenTask: (id, matches) =>
          service.subscribeList().pipe(
            Stream.filter(({ tasks }) => tasks.some((task) => task.id === id && matches(task))),
            Stream.runHead,
            Effect.orDie,
            Effect.forkScoped,
            Effect.map((fiber) => Fiber.join(fiber).pipe(Effect.asVoid)),
          ),
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const taskOf = (service: ScheduledTaskService.ScheduledTaskService["Service"], id: string) =>
  service
    .list()
    .pipe(Effect.map(({ tasks }) => tasks.find((task) => task.id === (id as ScheduledTaskId))));

it.effect("each run reads the prompt file again, so a push reaches the next run", () =>
  withService(({ service, remote, launched }) =>
    Effect.gen(function* () {
      const saved = (yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP))
        .task;
      expect(saved.prompt).toBe("Run the daily check.");
      expect(saved.promptFile).toEqual({
        path: PATH,
        lastRead: { at: "2026-09-09T12:00:00.000Z", ref: "origin/main", commit: "c1" },
      });

      yield* Ref.set(remote, { text: "Run the new check.", commit: "c2" });
      yield* TestClock.adjust("1 minute");
      yield* service.runNow({ id: saved.id });

      expect(yield* Ref.get(launched)).toEqual(["Run the new check."]);
      const after = yield* taskOf(service, saved.id);
      expect(after?.prompt).toBe("Run the new check.");
      expect(after?.promptFile?.lastRead).toEqual({
        at: "2026-09-09T12:01:00.000Z",
        ref: "origin/main",
        commit: "c2",
      });
    }),
  ),
);

it.effect("a run whose prompt file cannot be read fails and starts nothing", () =>
  withService(({ service, remote, launched }) =>
    Effect.gen(function* () {
      const saved = (yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP))
        .task;
      yield* Ref.set(remote, { text: null, commit: "c2" });

      const run = yield* service.runNow({ id: saved.id });

      const message =
        "Could not read the prompt file automations/daily.md from origin/main: it does not exist there.";
      expect(run.threadId).toBeNull();
      expect(yield* Ref.get(launched)).toEqual([]);
      expect(run.task).toMatchObject({ lastRunStatus: "failed", lastRunError: message });
      const [record] = (yield* service.listRuns({ id: saved.id })).runs;
      expect(record).toMatchObject({ outcome: "failed", error: message, threadId: null });
    }),
  ),
);

it.effect("saving keeps the file a client leaves out and refuses what cannot run", () =>
  withService(({ service, remote }) =>
    Effect.gen(function* () {
      const saved = (yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP))
        .task;
      yield* Ref.set(remote, { text: "Pushed since the save.", commit: "c2" });

      // A client without prompt files sends the text it shows and no file.
      const resaved = (yield* service.upsert(
        upsertInput({
          title: "Renamed",
          promptFile: undefined,
          prompt: "Edited on an old client.",
        }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
      expect(resaved).toMatchObject({
        title: "Renamed",
        prompt: "Run the daily check.",
        promptFile: { path: PATH, lastRead: { commit: "c1" } },
      });

      const refusals = [
        upsertInput({ id: "scheduled-task:missing", promptFile: "automations/missing.md" }),
        upsertInput({ id: "scheduled-task:hook", schedule: { type: "webhook" } }),
        upsertInput({ id: saved.id, promptFile: null }),
      ];
      const messages = yield* Effect.forEach(refusals, (input) =>
        service.upsert(input, ScheduledTaskService.CHANGED_IN_APP).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
      );
      expect(messages).toEqual([
        "Could not read the prompt file automations/missing.md from origin/main: it does not exist there.",
        "A webhook task fills its prompt from each request, so it can't read it from a file.",
        "A task needs a prompt, or a prompt file to read it from.",
      ]);

      const cleared = (yield* service.upsert(
        upsertInput({ id: saved.id, promptFile: null, prompt: "Typed by hand." }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
      expect(cleared).toMatchObject({ prompt: "Typed by hand.", promptFile: null });
    }),
  ),
);

it.effect("shared copies carry the file, and each machine reads it for itself", () =>
  withService(({ service, remote, launched }) =>
    Effect.gen(function* () {
      const shared = (yield* service.upsert(
        upsertInput({ shared: { excludedEnvironmentIds: [] } }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
      const copies = yield* service.sharedCopies("environment-other" as never, {
        recordPuller: false,
      });
      expect(copies.tasks.find((copy) => copy.id === shared.id)?.promptFile).toBe(PATH);

      // Another machine defined this one, and an app without prompt files passed it on first.
      yield* service.applyShared(sharedCopy("2026-09-09T11:00:00.000Z", { promptFile: undefined }));
      expect((yield* taskOf(service, "scheduled-task:copy"))?.promptFile).toBeNull();
      // The same revision with its file fills the file in; nothing here has read it yet.
      expect(yield* service.applyShared(sharedCopy("2026-09-09T11:00:00.000Z"))).toEqual({
        outcome: "applied",
      });
      expect(yield* taskOf(service, "scheduled-task:copy")).toMatchObject({
        prompt: "The text the other machine read.",
        promptFile: { path: PATH, lastRead: null },
      });

      yield* Ref.set(remote, { text: "Read here.", commit: "c3" });
      yield* service.runNow({ id: "scheduled-task:copy" as ScheduledTaskId });
      expect(yield* Ref.get(launched)).toEqual(["Read here."]);

      // A newer copy of the same file keeps this machine's read and the text it found.
      yield* service.applyShared(sharedCopy("2026-09-09T13:00:00.000Z", { title: "Renamed" }));
      expect(yield* taskOf(service, "scheduled-task:copy")).toMatchObject({
        title: "Renamed",
        prompt: "Read here.",
        promptFile: { path: PATH, lastRead: { commit: "c3" } },
      });

      // A copy without a file goes back to running its own text.
      yield* service.applyShared(
        sharedCopy("2026-09-09T14:00:00.000Z", { promptFile: null, prompt: "Typed elsewhere." }),
      );
      expect(yield* taskOf(service, "scheduled-task:copy")).toMatchObject({
        prompt: "Typed elsewhere.",
        promptFile: null,
      });
    }),
  ),
);

it.effect("a save that keeps the file's last read keeps what a run read meanwhile", () =>
  withService(({ service, remote, saveHold }) =>
    Effect.gen(function* () {
      const worktree = { type: "worktree", baseRef: "main" };
      const id = "scheduled-task:copy" as ScheduledTaskId;
      yield* service.applyShared(
        sharedCopy("2026-09-09T11:00:00.000Z", { enabled: false, workspaceStrategy: worktree }),
      );
      yield* service.runNow({ id });

      // Each save loads the task, then a run reads a newer push before the save writes.
      const saves = [
        service.applyShared(
          sharedCopy("2026-09-09T13:00:00.000Z", {
            enabled: false,
            title: "Renamed on the other machine",
            workspaceStrategy: worktree,
          }),
        ),
        service.upsert(
          upsertInput({
            id,
            title: "Renamed here",
            workspaceStrategy: worktree,
            shared: { excludedEnvironmentIds: [] },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        ),
      ];
      for (const [index, save] of saves.entries()) {
        const hold = yield* makeHold;
        yield* Ref.set(saveHold, hold);
        const saving = yield* Effect.forkChild(save);
        yield* Deferred.await(hold.reached);
        yield* Ref.set(remote, { text: `Push ${index}.`, commit: `push-${index}` });
        yield* service.runNow({ id });
        yield* Deferred.succeed(hold.release, undefined);
        yield* Fiber.join(saving);

        expect(yield* taskOf(service, id)).toMatchObject({
          prompt: `Push ${index}.`,
          promptFile: { path: PATH, lastRead: { commit: `push-${index}` } },
        });
      }
    }),
  ),
);

it.effect("a read that started before the stored one does not replace it", () =>
  withService(({ service, remote, launched }) =>
    Effect.gen(function* () {
      const id = "scheduled-task:copy" as ScheduledTaskId;
      // Nothing here has read the copy's file, so the next save reads it.
      yield* service.applyShared(sharedCopy("2026-09-09T11:00:00.000Z", { enabled: false }));
      const hold = yield* makeHold;
      yield* Ref.set(remote, { text: "Older push.", commit: "c1", hold });
      const run = yield* Effect.forkChild(service.runNow({ id }));
      yield* Deferred.await(hold.reached);

      yield* Ref.set(remote, { text: "Newer push.", commit: "c2" });
      yield* TestClock.adjust("1 minute");
      yield* service.upsert(
        upsertInput({ id, shared: { excludedEnvironmentIds: [] } }),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(run);

      // The run sends what it read, and the task keeps the later read.
      expect(yield* Ref.get(launched)).toEqual(["Older push."]);
      expect(yield* taskOf(service, id)).toMatchObject({
        prompt: "Newer push.",
        promptFile: { lastRead: { at: "2026-09-09T12:01:00.000Z", commit: "c2" } },
      });
    }),
  ),
);

it.effect("a scheduled run fetches its file in the background, so other due tasks start", () =>
  withService(({ service, remote, launched, poll, whenTask }) =>
    Effect.gen(function* () {
      // Due at the same time, and the file task is listed first.
      const fileTask = (yield* service.upsert(
        upsertInput({ enabled: true }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
      yield* service.upsert(
        upsertInput({
          id: "scheduled-task:plain",
          enabled: true,
          promptFile: null,
          prompt: "Run the plain check.",
        }),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      const hold = yield* makeHold;
      yield* Ref.set(remote, { text: "Pushed before the run.", commit: "c2", hold });
      yield* TestClock.setTime(Date.parse(fileTask.nextRunAt!) + 1_000);
      const fileRan = yield* whenTask(fileTask.id, (task) => task.lastRunStatus === "succeeded");

      yield* poll;
      yield* Deferred.await(hold.reached);
      expect(yield* Ref.get(launched)).toEqual(["Run the plain check."]);

      yield* Deferred.succeed(hold.release, undefined);
      yield* fileRan;
      expect(yield* Ref.get(launched)).toEqual(["Run the plain check.", "Pushed before the run."]);
    }),
  ),
);

it.effect(
  "a scheduled read that lost its connection runs once the network is back, and only once",
  () =>
    withService(({ service, remote, launched, network, poll, whenTask }) =>
      Effect.gen(function* () {
        const task = (yield* service.upsert(
          upsertInput({ enabled: true }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        yield* Ref.set(remote, {
          text: "Pushed before the wake.",
          commit: "c2",
          lostConnection: true,
        });
        yield* Ref.set(network.online, false);
        yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
        const fileRan = yield* whenTask(
          task.id,
          (current) => current.lastRunStatus === "succeeded",
        );

        yield* poll;
        expect(yield* Queue.take(network.probed)).toBe(false);
        // Fires while the run waits start nothing more.
        yield* poll;
        const manual = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
        expect(manual).toMatchObject({ cause: { message: "Schedule task is already running." } });

        yield* Ref.set(remote, { text: "Pushed before the wake.", commit: "c2" });
        yield* Ref.set(network.online, true);
        yield* TestClock.adjust("30 seconds");
        yield* fileRan;

        expect(yield* Ref.get(launched)).toEqual(["Pushed before the wake."]);
        expect((yield* service.listRuns({ id: task.id })).runs).toHaveLength(1);
      }),
    ),
);

it.effect("a scheduled read that waited for the network starts no chat once memory is short", () =>
  withService(({ service, remote, launched, network, memory, poll, whenTask }) =>
    Effect.gen(function* () {
      const task = (yield* service.upsert(
        upsertInput({ enabled: true }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
      yield* Ref.set(remote, {
        text: "Pushed before the wake.",
        commit: "c2",
        lostConnection: true,
      });
      yield* Ref.set(network.online, false);
      yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
      const ended = yield* whenTask(
        task.id,
        (current) => current.lastRunStatus === "failed" || current.lastRunStatus === "succeeded",
      );

      yield* poll;
      expect(yield* Queue.take(network.probed)).toBe(false);
      yield* Ref.set(memory, {
        kind: "available",
        totalBytes: 8 * 1024 ** 3,
        availableBytes: 1024 ** 3,
        reserveBytes: 2 * 1024 ** 3,
      });
      yield* Ref.set(remote, { text: "Pushed before the wake.", commit: "c2" });
      yield* Ref.set(network.online, true);
      yield* TestClock.adjust("30 seconds");
      yield* ended;

      expect(yield* Ref.get(launched)).toEqual([]);
      expect((yield* taskOf(service, task.id))?.lastRunError).toBe(
        "This machine's memory was short when the prompt file arrived (1 GiB of 8 GiB is available, under the 2 GiB reserve), so the chat did not start.",
      );
    }),
  ),
);

it.effect("a scheduled read gives up when the network is not back, and says so", () =>
  withService(({ service, remote, launched, network, poll, whenTask }) =>
    Effect.gen(function* () {
      const task = (yield* service.upsert(
        upsertInput({ enabled: true }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
      yield* Ref.set(remote, { text: "Never read.", commit: "c2", lostConnection: true });
      yield* Ref.set(network.online, false);
      yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
      const failed = yield* whenTask(task.id, (current) => current.lastRunStatus === "failed");

      yield* poll;
      yield* Queue.take(network.probed);
      for (let recheck = 0; recheck < 10; recheck++) {
        yield* TestClock.adjust("30 seconds");
        yield* Queue.take(network.probed);
      }
      yield* failed;

      expect(yield* Ref.get(launched)).toEqual([]);
      expect((yield* taskOf(service, task.id))?.lastRunError).toBe(
        `Could not read the prompt file ${PATH} from origin/main: ${LOST_DETAIL} The network was not back after 5 minutes.`,
      );
    }),
  ),
);

it.effect("a task paused while its run waits for the network does not run", () =>
  withService(({ service, remote, launched, network, poll, whenTask }) =>
    Effect.gen(function* () {
      const task = (yield* service.upsert(
        upsertInput({ enabled: true }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
      yield* Ref.set(remote, {
        text: "Pushed before the pause.",
        commit: "c2",
        lostConnection: true,
      });
      yield* Ref.set(network.online, false);
      yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
      const failed = yield* whenTask(task.id, (current) => current.lastRunStatus === "failed");

      yield* poll;
      yield* Queue.take(network.probed);
      yield* service.setEnabled(
        { id: task.id, enabled: false },
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* Ref.set(remote, { text: "Pushed before the pause.", commit: "c2" });
      yield* Ref.set(network.online, true);
      yield* TestClock.adjust("30 seconds");
      yield* failed;

      expect(yield* Ref.get(launched)).toEqual([]);
      expect((yield* taskOf(service, task.id))?.lastRunError).toBe(
        "The task was paused or deleted while its run waited for the network.",
      );
    }),
  ),
);
