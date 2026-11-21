import type {
  EnvironmentId,
  MonitoringChatsInput,
  MonitoringOverviewInput,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { type AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { createEnvironmentCatalogAtoms } from "../state/connections.ts";
import type { createEnvironmentPresentationAtoms } from "../state/presentation.ts";
import { runAtomCommand } from "../state/runtime.ts";
import type { createServerEnvironmentAtoms } from "../state/server.ts";
import {
  environmentReport,
  mergeMonitoringChats,
  mergeMonitoringOverviews,
  monitoringChatsInput,
  monitoringEnvironment,
  queryRead,
  type MonitoringChatsRequest,
  type MonitoringChatsSource,
  type MonitoringChatsView,
  type MonitoringEnvironment,
  type MonitoringOverviewView,
  type MonitoringQueryRead,
} from "./aggregate.ts";

function monitoringEnvironments(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): MonitoringEnvironment[] {
  const environments: MonitoringEnvironment[] = [];
  for (const [environmentId, presentation] of presentations) {
    const environment = monitoringEnvironment(environmentId, presentation);
    if (environment !== null) environments.push(environment);
  }
  return environments;
}

/** The overview and chat lists merged across every environment the user asked to connect. */
export function createMonitoringAtoms(input: {
  readonly label: string;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "monitoringOverview" | "monitoringChats"
  >;
  readonly presentations: Pick<
    ReturnType<typeof createEnvironmentPresentationAtoms>,
    "presentationsAtom"
  >;
  readonly catalog: Pick<ReturnType<typeof createEnvironmentCatalogAtoms>, "retryNow">;
  readonly describeFailure: (cause: Cause.Cause<unknown>) => string;
}) {
  const { registry, server, presentations, describeFailure } = input;

  const queryKey = (environmentId: EnvironmentId, input: object) =>
    JSON.stringify([environmentId, input]);
  const overviewQuery = (environmentId: EnvironmentId, input: MonitoringOverviewInput) =>
    server.monitoringOverview({ environmentId, input });
  const chatsQuery = (environmentId: EnvironmentId, input: MonitoringChatsInput) =>
    server.monitoringChats({ environmentId, input });

  type FailedRead = {
    readonly environmentId: EnvironmentId;
    readonly query: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
    unwatch: (() => void) | null;
  };
  /**
   * Queries whose failure a view read, which Refresh asks again whatever the views show now: a
   * query stays cached a while after its last reader leaves, so Show more reaching a page only a
   * longer list read, or a view coming back, would show the old failure. One stays here, loading
   * again included, until it answers, which Refresh watches for when no view reads it.
   */
  const failedReads = new Map<string, FailedRead>();
  const noteRead = <A>(
    result: AsyncResult.AsyncResult<A, unknown>,
    environmentId: EnvironmentId,
    key: string,
    query: FailedRead["query"],
  ): MonitoringQueryRead<A> => {
    if (result._tag === "Failure") {
      if (!failedReads.has(key)) failedReads.set(key, { environmentId, query, unwatch: null });
    } else if (result._tag === "Success" && !result.waiting) {
      failedReads.delete(key);
    }
    return queryRead(result, describeFailure);
  };
  const settle = (
    key: string,
    failed: FailedRead,
    result: AsyncResult.AsyncResult<unknown, unknown>,
  ) => {
    if (result.waiting) return;
    failed.unwatch?.();
    failed.unwatch = null;
    if (result._tag === "Failure") failedReads.set(key, failed);
    else if (failedReads.get(key) === failed) failedReads.delete(key);
  };
  const askFailed = (key: string, failed: FailedRead) => {
    failed.unwatch ??= registry.subscribe(failed.query, (result) => settle(key, failed, result));
    registry.refresh(failed.query);
    settle(key, failed, registry.get(failed.query));
  };

  const overviewAtom = Atom.family((inputKey: string) =>
    Atom.make((get): MonitoringOverviewView => {
      const overview = JSON.parse(inputKey) as MonitoringOverviewInput;
      return mergeMonitoringOverviews(
        monitoringEnvironments(get(presentations.presentationsAtom)).map((environment) => {
          const { environmentId } = environment;
          return environmentReport(environment, () =>
            noteRead(
              get(overviewQuery(environmentId, overview)),
              environmentId,
              queryKey(environmentId, overview),
              overviewQuery(environmentId, overview),
            ),
          );
        }),
      );
    }).pipe(Atom.withLabel(`${input.label}:overview:${inputKey}`)),
  );

  /**
   * The offsets each chat list has read, by request and environment. Retry asks them all again:
   * the latest merge can stop before a failed page, and a repeated chat can make it read past the
   * limit. A refresh runs a page nothing reads too, so pages only a longer list read wait in the
   * cache: a settled chat marks them stale for the next read, and a failed one is in failedReads.
   */
  const offsetsRead = new Map<string, Map<EnvironmentId, Set<number>>>();

  const chatsAtom = Atom.family((requestKey: string) =>
    Atom.make((get): MonitoringChatsView => {
      const request = JSON.parse(requestKey) as MonitoringChatsRequest;
      const listRead = offsetsRead.get(requestKey) ?? new Map<EnvironmentId, Set<number>>();
      offsetsRead.set(requestKey, listRead);
      const sources: MonitoringChatsSource[] = [];
      for (const environment of monitoringEnvironments(get(presentations.presentationsAtom))) {
        const { environmentId } = environment;
        const firstPage = monitoringChatsInput(environmentId, request, 0);
        if (firstPage === null) continue;
        const offsets = listRead.get(environmentId) ?? new Set<number>();
        listRead.set(environmentId, offsets);
        sources.push({
          environment,
          readPage: (offset) => {
            offsets.add(offset);
            const page = { ...firstPage, offset };
            return noteRead(
              get(chatsQuery(environmentId, page)),
              environmentId,
              queryKey(environmentId, page),
              chatsQuery(environmentId, page),
            );
          },
        });
      }
      return mergeMonitoringChats(sources, request);
    }).pipe(Atom.withLabel(`${input.label}:chats:${requestKey}`)),
  );

  /**
   * Asks again for everything the given views show, the overview and every chat page each list
   * read, and for every failure a view read; an open chat's analysis passes neither. An environment
   * that is not connected reconnects now, skipping its backoff, so Retry reaches one whose
   * connection failed and not only its old answer.
   */
  const refresh = (views: {
    readonly overview?: MonitoringOverviewInput;
    readonly chats?: ReadonlyArray<MonitoringChatsRequest>;
  }) => {
    const environments = monitoringEnvironments(registry.get(presentations.presentationsAtom));
    const ready = new Set<EnvironmentId>();
    const asks = new Map<string, () => void>();
    const ask = (key: string, query: Atom.Atom<unknown>) =>
      asks.set(key, () => registry.refresh(query));
    for (const { environmentId, unready } of environments) {
      if (unready === null) {
        ready.add(environmentId);
        const { overview } = views;
        if (overview !== undefined) {
          ask(queryKey(environmentId, overview), overviewQuery(environmentId, overview));
        }
      } else if (unready.reconnects) {
        void runAtomCommand(registry, input.catalog.retryNow, environmentId, {
          label: "monitoring environment retry",
        });
      }
    }
    for (const request of views.chats ?? []) {
      const listRead = offsetsRead.get(JSON.stringify(request));
      for (const environmentId of ready) {
        const firstPage = monitoringChatsInput(environmentId, request, 0);
        if (firstPage === null) continue;
        for (const offset of listRead?.get(environmentId) ?? []) {
          const page = { ...firstPage, offset };
          ask(queryKey(environmentId, page), chatsQuery(environmentId, page));
        }
      }
    }
    for (const [key, failed] of failedReads) {
      if (ready.has(failed.environmentId)) asks.set(key, () => askFailed(key, failed));
    }
    for (const run of asks.values()) run();
  };

  return { overviewAtom, chatsAtom, refresh };
}
