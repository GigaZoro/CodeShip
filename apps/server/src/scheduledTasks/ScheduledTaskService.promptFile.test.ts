import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
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
 * hold keeps a read from answering until it is released.
 */
type Remote = Ref.Ref<{
  readonly text: string | null;
  readonly commit: string;
  readonly hold?: Hold;
}>;

interface Harness {
  readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
  readonly remote: Remote;
  readonly launched: Ref.Ref<ReadonlyArray<string>>;
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
    const saveHold = yield* Ref.make<Hold | undefined>(undefined);
    const workers = new Map<string, Effect.Effect<void>>();
    const reader = Layer.mock(PromptFileReader.PromptFileReader)({
      read: ({ cwd, path }) =>
        Effect.gen(function* () {
          const { text, commit, hold } = yield* Ref.get(remote);
          yield* waitAt(hold);
          if (cwd === project.workspaceRoot && path === PATH && text !== null) {
            return { text, ref: "origin/main", commit };
          }
          return yield* new PromptFileReader.PromptFileReadError({
            path,
            ref: "origin/main",
            detail: "it does not exist there.",
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
          ManagedPolicy.layerTest(),
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
      const saved = (yield* service.upsert(upsertInput())).task;
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
      const saved = (yield* service.upsert(upsertInput())).task;
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
      const saved = (yield* service.upsert(upsertInput())).task;
      yield* Ref.set(remote, { text: "Pushed since the save.", commit: "c2" });

      // A client without prompt files sends the text it shows and no file.
      const resaved = (yield* service.upsert(
        upsertInput({
          title: "Renamed",
          promptFile: undefined,
          prompt: "Edited on an old client.",
        }),
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
        service.upsert(input).pipe(
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
      yield* service.upsert(upsertInput({ id, shared: { excludedEnvironmentIds: [] } }));
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
      const fileTask = (yield* service.upsert(upsertInput({ enabled: true }))).task;
      yield* service.upsert(
        upsertInput({
          id: "scheduled-task:plain",
          enabled: true,
          promptFile: null,
          prompt: "Run the plain check.",
        }),
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
