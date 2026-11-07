import type { AgentConversationSyncResult, ServerSettings } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  agentConversationImportPolicy,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

// Picks up conversations started outside T3.CodeShip; startup covers the time the server was off.
const SYNC_INTERVAL = "10 minutes";

interface ImportedSincePolicyChange extends AgentConversationSyncResult {
  readonly policy: string;
  readonly epoch: number;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

  const imported = yield* Ref.make<ImportedSincePolicyChange>({
    policy: agentConversationImportPolicy(yield* settingsService.getSettings.pipe(Effect.orDie)),
    epoch: 0,
    importedCount: 0,
    latestThread: null,
    complete: true,
  });
  // Whoever sees a new policy first (the change stream or a run) starts a new epoch, so runs
  // that began under the old one never count toward it.
  const observePolicy = (settings: ServerSettings) =>
    Ref.modify(imported, (current) => {
      const policy = agentConversationImportPolicy(settings);
      if (policy === current.policy) return [{ changed: false, epoch: current.epoch }, current];
      const epoch = current.epoch + 1;
      return [
        { changed: true, epoch },
        { policy, epoch, importedCount: 0, latestThread: null, complete: true },
      ];
    });

  const sync = Effect.fn("AgentConversationSync.sync")(function* () {
    const settings = yield* settingsService.getSettings;
    const { epoch } = yield* observePolicy(settings);
    const record = (update: (current: ImportedSincePolicyChange) => ImportedSincePolicyChange) =>
      Ref.update(imported, (current) => (current.epoch === epoch ? update(current) : current));
    const enabled = (yield* projects.listShells()).filter(
      (project) => resolveProjectSettings(settings, project.id).settings.importAgentConversations,
    );
    if (enabled.length === 0) return;
    yield* scanner.refresh.pipe(
      Effect.tapError(() => record((current) => ({ ...current, complete: false }))),
    );
    for (const project of enabled) {
      yield* importer.importAllAgentThreads(project.id).pipe(
        Effect.flatMap(({ createdCount, latestCreated }) =>
          record((current) => ({
            ...current,
            importedCount: current.importedCount + createdCount,
            latestThread:
              latestCreated !== null &&
              (current.latestThread === null ||
                latestCreated.updatedAt > current.latestThread.updatedAt)
                ? latestCreated
                : current.latestThread,
          })),
        ),
        Effect.catch((cause) =>
          record((current) => ({ ...current, complete: false })).pipe(
            Effect.andThen(
              Effect.logWarning("Could not import agent conversations", {
                projectId: project.id,
                cause,
              }),
            ),
          ),
        ),
      );
    }
  });

  const queued = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(() =>
    Ref.set(queued, false).pipe(
      Effect.andThen(sync()),
      Effect.catchCause((cause) => Effect.logWarning("Agent conversation sync failed", { cause })),
    ),
  );
  const requestSync = Ref.getAndSet(queued, true).pipe(
    Effect.flatMap((alreadyQueued) => (alreadyQueued ? Effect.void : worker.enqueue(undefined))),
  );

  const changes = yield* settingsService.subscribeChanges;
  yield* forkParked(
    requestSync.pipe(
      Effect.andThen(worker.drain),
      Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
      Effect.asVoid,
    ),
  );
  yield* forkParked(
    Stream.runForEach(changes, (settings) =>
      observePolicy(settings).pipe(
        Effect.flatMap(({ changed }) => (changed ? requestSync : Effect.void)),
      ),
    ),
  );
  const afterSequence = yield* applicationEvents.latestApplicationSequence.pipe(Effect.orDie);
  yield* forkParked(
    applicationEvents.streamApplicationEvents({ afterSequence }).pipe(
      Stream.filter((event) => "type" in event && event.type === "project.created"),
      Stream.runForEach(() => requestSync),
      Effect.catchCause((cause) =>
        Effect.logWarning("Agent conversation sync stopped watching new projects", { cause }),
      ),
    ),
  );

  return {
    /** Runs a sync under the current settings, then reports everything since they last changed. */
    importedSinceSettingsChange: Effect.fn("AgentConversationSync.importedSinceSettingsChange")(
      function* () {
        yield* requestSync;
        yield* worker.drain;
        const { importedCount, latestThread, complete } = yield* Ref.get(imported);
        return { importedCount, latestThread, complete } satisfies AgentConversationSyncResult;
      },
    ),
  };
});

export class AgentConversationSync extends Context.Service<
  AgentConversationSync,
  Effect.Success<typeof make>
>()("t3/project/AgentConversationSync") {}

export const layer = Layer.effect(AgentConversationSync, make);
