import type {
  EnvironmentId,
  MonitoringChange,
  MonitoringChatsInput,
  MonitoringOverviewInput,
  MonitoringThreadDetail,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentCatalogAtoms } from "../state/connections.ts";
import type { createEnvironmentPresentationAtoms } from "../state/presentation.ts";
import { executeAtomQuery, runAtomCommand, type AtomQueryOptions } from "../state/runtime.ts";
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
  type MonitoringRetry,
} from "./aggregate.ts";

export function monitoringThreadPresentation<
  A extends {
    readonly detail: MonitoringThreadDetail | null;
    readonly sessionToken: symbol;
  },
  E,
>(query: Atom.Atom<AsyncResult.AsyncResult<A, E>>, sessionToken: Atom.Atom<symbol | null>) {
  return Atom.make((get) => {
    const result = get(query);
    const active = get(sessionToken);
    const answer = AsyncResult.getOrElse(result, () => null);
    return {
      result,
      detail: answer?.detail ?? null,
      retained: answer !== null && answer.sessionToken !== active,
    };
  });
}

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

/**
 * Defer invalidations while a read is in flight. Its answer may already include the change.
 * When a subscriber skips a batch, the newest notice cannot tell it which threads it missed.
 */
export function followMonitoringChanges<A extends object | null, E, F>(
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  changes: Atom.Atom<AsyncResult.AsyncResult<MonitoringChange, F>>,
  threadId?: ThreadId,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  const state = new WeakMap<
    AtomRegistry.AtomRegistry,
    {
      seen: MonitoringChange | null;
      pending: MonitoringChange | null;
      answerEpoch: string | undefined;
    }
  >();
  return Atom.transform(
    query,
    (get) => {
      const notice = AsyncResult.getOrElse(get(changes), () => null);
      const result = get(query);
      const cursor = state.get(get.registry) ?? {
        seen: null,
        pending: null,
        answerEpoch: undefined,
      };
      state.set(get.registry, cursor);
      const answer = answerVersion(result);
      if (
        result._tag === "Success" &&
        answer?.serverEpoch !== undefined &&
        answer.serverEpoch !== cursor.answerEpoch
      ) {
        if (cursor.pending?.serverEpoch === cursor.answerEpoch) cursor.pending = null;
        cursor.answerEpoch = answer.serverEpoch;
      }
      if (notice !== null && notice !== cursor.seen) {
        const seen = cursor.seen;
        const sameEpoch = seen?.serverEpoch === notice.serverEpoch;
        const reset = !sameEpoch || (seen !== null && notice.revision <= seen.revision);
        if (reset) cursor.pending = null;
        const baseline =
          reset || seen === null
            ? answer?.serverEpoch === notice.serverEpoch
              ? (answer?.revision ?? 0)
              : 0
            : seen.revision;
        const mayHaveMissed = notice.sinceRevision !== undefined && notice.sinceRevision > baseline;
        if (
          threadId === undefined ||
          mayHaveMissed ||
          notice.threadIds?.includes(threadId) !== false
        ) {
          cursor.pending = notice;
        }
        cursor.seen = notice;
      }
      const pending = cursor.pending;
      if (pending === null || result.waiting || result._tag === "Initial") return result;
      if (
        result._tag !== "Failure" &&
        answer?.serverEpoch !== undefined &&
        pending.serverEpoch !== undefined &&
        answer.serverEpoch !== pending.serverEpoch
      )
        return result;
      if (
        answer?.serverEpoch === pending.serverEpoch &&
        pending.revision <= (answer?.revision ?? -1)
      ) {
        cursor.pending = null;
        return result;
      }
      // Readers and a manual refresh can consume this completion before the next read starts.
      let current = true;
      get.addFinalizer(() => {
        current = false;
      });
      queueMicrotask(() => {
        if (!current || cursor.pending !== pending || get.registry.get(query) !== result) return;
        cursor.pending = null;
        get.registry.refresh(query);
      });
      return result;
    },
    { initialValueTarget: query },
  );
}

function answerVersion<A extends object | null, E>(result: AsyncResult.AsyncResult<A, E>) {
  const value = AsyncResult.getOrElse(result, () => null);
  if (value === null || !("revision" in value) || typeof value.revision !== "number") return null;
  return {
    revision: value.revision,
    serverEpoch:
      "serverEpoch" in value && typeof value.serverEpoch === "string"
        ? value.serverEpoch
        : undefined,
  };
}

export const MONITORING_REQUEST_TIMEOUT_MS = 15_000;
const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

export function executeMonitoringQuery<A, E>(
  registry: AtomRegistry.AtomRegistry,
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  environmentId: EnvironmentId,
  options: AtomQueryOptions = {},
) {
  return executeAtomQuery(registry, query, {
    reportFailure: false,
    reportDefect: false,
    ...options,
    deadline: {
      milliseconds: MONITORING_REQUEST_TIMEOUT_MS,
      error: new EnvironmentRpcUnavailableError({
        environmentId,
        reason: "timeout",
        // oxlint-disable-next-line t3code/no-untranslated-text -- Monitoring displays its own translated timeout status.
        message: "The request timed out.",
      }),
    },
  });
}

export function monitoringRefreshTimedOut(result: AsyncResult.AsyncResult<unknown, unknown>) {
  if (result._tag !== "Failure") return false;
  const error = Cause.squash(result.cause);
  return isEnvironmentRpcUnavailable(error) && error.reason === "timeout";
}

type MonitoringOperationState = "settled" | "pending" | "timed-out";

export function createMonitoringOperation() {
  const state = Atom.make<MonitoringOperationState>("settled");
  const run = async (registry: AtomRegistry.AtomRegistry, refresh: () => Promise<boolean>) => {
    if (registry.get(state) === "pending") return;
    registry.set(state, "pending");
    try {
      registry.set(state, (await refresh()) ? "timed-out" : "settled");
    } catch (error) {
      registry.set(state, "settled");
      throw error;
    }
  };
  return { state, run };
}

export function monitoringOperationRetry(
  retry: MonitoringRetry,
  pending: boolean,
): MonitoringRetry {
  if (retry === "unavailable") return retry;
  return pending ? "busy" : "available";
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
      const previous = Option.getOrNull(get.self<MonitoringOverviewView>());
      return mergeMonitoringOverviews(
        monitoringEnvironments(get(presentations.presentationsAtom)).map((environment) => {
          const { environmentId } = environment;
          const query = overviewQuery(environmentId, overview);
          const previousReport = previous?.environments.find(
            (report) => report.environmentId === environmentId,
          );
          return environmentReport(
            environment,
            () => noteRead(get(query), environmentId, queryKey(environmentId, overview), query),
            previousReport?.result,
            previousReport,
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
      const environments = monitoringEnvironments(get(presentations.presentationsAtom));
      for (const environment of environments) {
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
      return mergeMonitoringChats(
        sources,
        request,
        Option.getOrUndefined(get.self<MonitoringChatsView>()),
        environments.map(({ environmentId }) => environmentId),
      );
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
    const asks = new Map<
      string,
      { environmentId: EnvironmentId; query: FailedRead["query"]; run: () => void }
    >();
    const ask = (environmentId: EnvironmentId, key: string, query: FailedRead["query"]) =>
      asks.set(key, { environmentId, query, run: () => registry.refresh(query) });
    for (const { environmentId, unready } of environments) {
      if (unready === null) {
        ready.add(environmentId);
        const { overview } = views;
        if (overview !== undefined) {
          ask(
            environmentId,
            queryKey(environmentId, overview),
            overviewQuery(environmentId, overview),
          );
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
          ask(environmentId, queryKey(environmentId, page), chatsQuery(environmentId, page));
        }
      }
    }
    for (const [key, failed] of failedReads) {
      if (ready.has(failed.environmentId)) {
        asks.set(key, {
          environmentId: failed.environmentId,
          query: failed.query,
          run: () => askFailed(key, failed),
        });
      }
    }
    const pending = [];
    for (const [key, { environmentId, query, run }] of asks) {
      run();
      pending.push(
        executeMonitoringQuery(registry, query, environmentId).then((result) => {
          const failed = failedReads.get(key);
          if (failed !== undefined && monitoringRefreshTimedOut(result)) {
            failed.unwatch?.();
            failed.unwatch = null;
          }
          return result;
        }),
      );
    }
    return Promise.all(pending);
  };

  return { overviewAtom, chatsAtom, refresh };
}
