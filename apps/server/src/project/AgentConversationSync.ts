import type { ServerSettings } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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

// Picks up conversations started outside CodeShip; startup covers the time the server was off.
const SYNC_INTERVAL = "10 minutes";

function syncPolicy(settings: ServerSettings): string {
  return JSON.stringify([
    settings.importAgentConversations,
    Object.entries(settings.projectSettingsOverrides)
      .flatMap(([projectId, overrides]) =>
        overrides.importAgentConversations === undefined
          ? []
          : [[projectId, overrides.importAgentConversations] as const],
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

  const sync = Effect.fn("AgentConversationSync.sync")(function* () {
    const settings = yield* settingsService.getSettings;
    const enabled = (yield* projects.listShells()).filter(
      (project) => resolveProjectSettings(settings, project.id).settings.importAgentConversations,
    );
    if (enabled.length === 0) return;
    yield* scanner.refresh;
    for (const project of enabled) {
      yield* importer.importAllAgentThreads(project.id).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import agent conversations", {
            projectId: project.id,
            cause,
          }),
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
  let lastPolicy = syncPolicy(yield* settingsService.getSettings.pipe(Effect.orDie));
  yield* forkParked(
    requestSync.pipe(
      Effect.andThen(worker.drain),
      Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
      Effect.asVoid,
    ),
  );
  yield* forkParked(
    Stream.runForEach(changes, (settings) => {
      const policy = syncPolicy(settings);
      if (policy === lastPolicy) return Effect.void;
      lastPolicy = policy;
      return requestSync;
    }),
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
});

export const layer = Layer.effectDiscard(make);
