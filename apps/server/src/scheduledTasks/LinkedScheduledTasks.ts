import {
  EnvironmentId,
  ForwardCompatibleArray,
  LinkedScheduledTask,
  NonNegativeInt,
  OrchestratorMcpListScheduledTasksResult,
  type LinkedScheduledTaskMachine,
  type LinkedScheduledTasksResult,
  type PeerLink,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { forkParked } from "../serverActivation.ts";

const REFRESH_INTERVAL = Duration.minutes(5);
/** A page opening refreshes only a list older than this, so reopening it stays cheap. */
const REFRESH_ON_OPEN_AFTER = Duration.minutes(1);
const PROJECT_PAGE_SIZE = 100;
const MAX_PROJECT_PAGES = 10;

const ProjectPage = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: ProjectId, title: Schema.String })),
  nextCursor: Schema.NullOr(NonNegativeInt),
});

const TasksJson = Schema.fromJsonString(ForwardCompatibleArray(LinkedScheduledTask));
const decodeTasks = Schema.decodeUnknownEffect(TasksJson);
const encodeTasks = Schema.encodeEffect(TasksJson);

interface SnapshotRow {
  readonly environment_id: string;
  readonly label: string;
  readonly tasks_json: string;
  readonly seen_at: string | null;
  readonly checked_at: string;
  readonly error: string | null;
}

/**
 * Keeps the last task list of each machine this one links to, so clients still see a machine's
 * tasks while it is offline. Refreshes every few minutes, and when a client opens the list.
 */
export class LinkedScheduledTasks extends Context.Service<
  LinkedScheduledTasks,
  {
    /** Asks every linked machine for its tasks now, unless a refresh is already running. */
    readonly refresh: Effect.Effect<void>;
    /** The stored lists, then the lists again after each refresh. */
    readonly subscribe: () => Stream.Stream<LinkedScheduledTasksResult>;
  }
>()("t3/scheduledTasks/LinkedScheduledTasks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const links = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.sliding<void>(1);
  const refreshing = yield* Semaphore.make(1);
  const lastRefreshAt = yield* Ref.make<DateTime.Utc | null>(null);

  const askTasks = (environmentId: EnvironmentId) =>
    client
      .call({
        environmentId,
        tool: "list_scheduled_tasks",
        arguments: { includePrompt: true },
        limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
        success: OrchestratorMcpListScheduledTasksResult,
      })
      .pipe(
        Effect.timeoutOption(PeerMcpClient.PEER_READ_TIMEOUT),
        Effect.flatMap((answer) =>
          Option.isSome(answer)
            ? Effect.succeed(answer.value.tasks)
            : Effect.fail({ message: "It did not answer in time." }),
        ),
      );

  // Titles only: a machine's projects are its own, so this one cannot look them up later.
  const askProjectTitles = Effect.fn("LinkedScheduledTasks.askProjectTitles")(function* (
    environmentId: EnvironmentId,
  ) {
    const titles = new Map<string, string>();
    let cursor: number | null = 0;
    for (let page = 0; page < MAX_PROJECT_PAGES && cursor !== null; page += 1) {
      const answer: Option.Option<typeof ProjectPage.Type> = yield* client
        .call({
          environmentId,
          tool: "t3_project_list",
          arguments: { cursor, limit: PROJECT_PAGE_SIZE },
          limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
          success: ProjectPage,
        })
        .pipe(Effect.timeoutOption(PeerMcpClient.PEER_READ_TIMEOUT));
      if (Option.isNone(answer)) break;
      for (const project of answer.value.projects) titles.set(project.id, project.title);
      cursor = answer.value.nextCursor;
    }
    return titles;
  });

  const recordAnswer = Effect.fn("LinkedScheduledTasks.recordAnswer")(function* (
    environmentId: EnvironmentId,
    tasks: ReadonlyArray<LinkedScheduledTask>,
    now: string,
  ) {
    const tasksJson = yield* encodeTasks(tasks);
    yield* sql`
      INSERT INTO peer_scheduled_task_snapshots
        (environment_id, tasks_json, seen_at, checked_at, error)
      VALUES (${environmentId}, ${tasksJson}, ${now}, ${now}, NULL)
      ON CONFLICT (environment_id) DO UPDATE SET
        tasks_json = excluded.tasks_json,
        seen_at = excluded.seen_at,
        checked_at = excluded.checked_at,
        error = NULL
    `;
  });

  // Keeps the tasks it last reported: that list is what an offline machine shows.
  const recordFailure = (environmentId: EnvironmentId, error: string, now: string) => sql`
    INSERT INTO peer_scheduled_task_snapshots
      (environment_id, tasks_json, seen_at, checked_at, error)
    VALUES (${environmentId}, '[]', NULL, ${now}, ${error})
    ON CONFLICT (environment_id) DO UPDATE SET
      checked_at = excluded.checked_at,
      error = excluded.error
  `;

  const refreshFrom = Effect.fn("LinkedScheduledTasks.refreshFrom")(function* (
    link: PeerLink,
    now: DateTime.Utc,
  ) {
    const at = DateTime.formatIso(now);
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, now)) {
      return yield* recordFailure(link.environmentId, "The link has expired.", at);
    }
    const answer = yield* Effect.all(
      [
        askTasks(link.environmentId),
        // A machine whose projects cannot be listed still shows its tasks, without project names.
        askProjectTitles(link.environmentId).pipe(
          Effect.orElseSucceed(() => new Map<string, string>()),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.result);
    if (answer._tag === "Failure") {
      return yield* recordFailure(link.environmentId, answer.failure.message, at);
    }
    const [tasks, titles] = answer.success;
    yield* recordAnswer(
      link.environmentId,
      tasks.map((task): LinkedScheduledTask => ({
        id: task.scheduledTaskId,
        title: task.title,
        prompt: task.prompt ?? task.promptPreview ?? "",
        enabled: task.enabled,
        projectId: task.projectId,
        projectTitle: titles.get(task.projectId) ?? null,
        schedule: task.schedule,
        nextRunAt: task.nextRunAt,
        lastRunStatus: task.lastRunStatus,
        lastRunAt: task.lastRun?.at ?? null,
        shared: task.shared === true,
        lastNoWorkSkip: task.lastSkipped ?? null,
      })),
      at,
    );
  });

  const refreshAll = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    const stored = yield* links.listStored;
    const now = yield* DateTime.now;
    yield* Ref.set(lastRefreshAt, now);
    yield* Effect.forEach(
      stored,
      (link) =>
        refreshFrom(link, now).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not refresh a linked machine's scheduled tasks", {
              peer: link.environmentId,
              cause,
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
    // Removing a link removes its machine from every client's list.
    yield* sql`
      DELETE FROM peer_scheduled_task_snapshots
      WHERE environment_id NOT IN (SELECT environment_id FROM peer_environment_links)
    `;
    yield* PubSub.publish(changes, undefined);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not refresh linked machines' scheduled tasks", { cause }),
    ),
    Effect.withSpan("LinkedScheduledTasks.refreshAll"),
  );

  const refresh = refreshing.withPermitsIfAvailable(1)(refreshAll).pipe(Effect.asVoid);

  const refreshIfStale = Effect.gen(function* () {
    const last = yield* Ref.get(lastRefreshAt);
    const now = yield* DateTime.now;
    if (last !== null && Duration.isLessThan(DateTime.distance(last, now), REFRESH_ON_OPEN_AFTER)) {
      return;
    }
    yield* refresh;
  });

  const toMachine = Effect.fn("LinkedScheduledTasks.toMachine")(function* (row: SnapshotRow) {
    const tasks = yield* decodeTasks(row.tasks_json).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read a linked machine's stored scheduled tasks", {
          peer: row.environment_id,
          reason: error.message,
        }).pipe(Effect.as([] as ReadonlyArray<LinkedScheduledTask>)),
      ),
    );
    return {
      environmentId: EnvironmentId.make(row.environment_id),
      label: row.label,
      seenAt: row.seen_at,
      checkedAt: row.checked_at,
      error: row.error,
      tasks,
    } satisfies LinkedScheduledTaskMachine;
  });

  const read: Effect.Effect<LinkedScheduledTasksResult> = Effect.gen(function* () {
    if (!(yield* links.enabled)) return { machines: [] };
    const rows = yield* sql<SnapshotRow>`
      SELECT snapshot.environment_id, link.label, snapshot.tasks_json, snapshot.seen_at,
        snapshot.checked_at, snapshot.error
      FROM peer_scheduled_task_snapshots AS snapshot
      JOIN peer_environment_links AS link ON link.environment_id = snapshot.environment_id
      ORDER BY link.label, snapshot.environment_id
    `;
    return { machines: yield* Effect.forEach(rows, toMachine) };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read linked machines' scheduled tasks", { cause }).pipe(
        Effect.as({ machines: [] }),
      ),
    ),
  );

  const subscribe: LinkedScheduledTasks["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(changes);
        yield* Effect.forkIn(refreshIfStale, scope);
        return Stream.concat(
          Stream.fromEffect(read),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
        );
      }),
    );

  // Waits first: stored lists survive restarts, and opening the list refreshes a stale one.
  yield* forkParked(Effect.sleep(REFRESH_INTERVAL).pipe(Effect.andThen(refresh), Effect.forever));

  return LinkedScheduledTasks.of({ refresh, subscribe });
});

export const layer = Layer.effect(LinkedScheduledTasks, make);
