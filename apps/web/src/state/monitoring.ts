import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type {
  EnvironmentId,
  MonitoringFindingCode,
  MonitoringOverviewInput,
  MonitoringThreadDetail,
  ThreadId,
} from "@t3tools/contracts";
import {
  createFixChatView,
  fixChatRequest,
  fixChatViewKey,
  presentMonitoringChats,
  presentMonitoringOverview,
  settleFixChat,
  type MonitoringChatsRequest,
  type MonitoringFixChatTarget,
} from "@t3tools/client-runtime/monitoring";
import {
  createMonitoringAtoms,
  createMonitoringOperation,
  executeMonitoringQuery,
  monitoringRefreshTimedOut,
} from "@t3tools/client-runtime/monitoring/atoms";
import { monitoringFixChatFailureMessage } from "@t3tools/client-runtime/monitoring-text";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useContext, useLayoutEffect, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const monitoring = createMonitoringAtoms({
  label: "web-monitoring",
  registry: appAtomRegistry,
  server: serverEnvironment,
  presentations: environmentPresentations,
  catalog: environmentCatalog,
  describeFailure: formatEnvironmentQueryError,
});

export function useMonitoringOverview(input: MonitoringOverviewInput) {
  const key = JSON.stringify(input);
  const view = useAtomValue(monitoring.overviewAtom(key));
  const next = { key, view, days: input.days };
  const [shown, setShown] = useState(next);
  const { keep, ...displayed } = presentMonitoringOverview(shown, next);
  if (!keep && (shown.key !== key || shown.view !== view)) setShown(next);
  return { ...displayed, retained: keep };
}

export function useMonitoringChats(request: MonitoringChatsRequest) {
  const view = useAtomValue(monitoring.chatsAtom(JSON.stringify(request)));
  const next = { request, view };
  const [shown, setShown] = useState(next);
  const { keep, ...displayed } = presentMonitoringChats(shown, next);
  if (!keep && shown.view !== view) setShown(next);
  return displayed;
}

export const refreshMonitoring = monitoring.refresh;

export function useMonitoringRefresh(key: string | null = null) {
  const registry = useContext(RegistryContext);
  const [current, setCurrent] = useState(() => ({ key, operation: createMonitoringOperation() }));
  const next = current.key === key ? current : { key, operation: createMonitoringOperation() };
  if (next !== current) setCurrent(next);
  const state = useAtomValue(next.operation.state);
  return {
    refreshing: state === "pending",
    timedOut: state === "timed-out",
    run: (refresh: () => Promise<boolean>) => next.operation.run(registry, refresh),
  };
}

export interface MonitoringThreadView {
  readonly detail: MonitoringThreadDetail | null;
  readonly retained: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
}

export function useMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
): MonitoringThreadView {
  const { result, detail, retained } = useAtomValue(
    serverEnvironment.monitoringThreadView(environmentId, threadId),
  );
  return {
    retained,
    detail,
    isPending: result.waiting,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
  };
}

/** Asks for the chat's analysis again and, as Refresh on the list does, every failure a view read. */
export async function refreshMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
) {
  const [detail, other] = await Promise.all([
    executeMonitoringQuery(
      appAtomRegistry,
      serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
      environmentId,
      { refresh: true },
    ),
    monitoring.refresh({}),
  ]);
  return monitoringRefreshTimedOut(detail) || other.some(monitoringRefreshTimedOut);
}

export interface MonitoringFixChat {
  readonly code: MonitoringFindingCode;
  /** False when no chat shows the weak point, or its machine cannot start one for this client. */
  readonly available: boolean;
  readonly pending: boolean;
  readonly failure: string | null;
  /** The chat this button started, linked in case opening it fails. */
  readonly started: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  readonly start: () => void;
}

/** Starts a chat that traces one weak point in `target`'s chats to its root cause and fixes it. */
export function useMonitoringFixChat(
  target: MonitoringFixChatTarget | null,
  code: MonitoringFindingCode,
): MonitoringFixChat {
  const run = useAtomCommand(serverEnvironment.startMonitoringFixChat, {
    label: "monitoring start fix chat",
    reportFailure: false,
  });
  const available = useAtomValue(
    serverEnvironment.monitoringFixChatsAvailable(target?.environmentId ?? null),
  );
  const navigate = useNavigate();
  const router = useRouter();
  const key = fixChatViewKey(target, code);
  const idle = () => ({
    view: createFixChatView(key),
    pending: false,
    failure: null,
    started: null,
  });
  const [stored, setStored] = useState<
    Pick<MonitoringFixChat, "pending" | "failure" | "started"> & {
      readonly view: ReturnType<typeof createFixChatView>;
    }
  >(idle);
  const state = stored.view.key === key ? stored : idle();
  if (state !== stored) setStored(state);
  const { view, pending, failure, started } = state;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the reply's route subscription when its view changes or unmounts
  useLayoutEffect(() => view.cancelReply, [view]);
  const start = () => {
    if (target === null || !available) return;
    const startedAt = router.history.location.href;
    const reply = view.watchReply(
      (leave) =>
        router.history.subscribe(({ location }) => {
          if (location.href !== startedAt) leave();
        }),
      () => setStored({ ...state, pending: false, failure: null }),
    );
    if (reply === null) return;
    const request = fixChatRequest(target, code, "web", randomUUID);
    setStored({ ...state, pending: true, failure: null });
    void run(request).then((result) => {
      const current = !reply.signal.aborted;
      reply.abort();
      const failure = result._tag === "Failure" ? result.cause : null;
      settleFixChat(target, code, request, failure);
      if (!current) return;
      if (result._tag === "Success") {
        const chat = { environmentId: request.environmentId, threadId: result.value.threadId };
        setStored({ ...state, pending: false, started: chat, failure: null });
        void navigate({ to: "/$environmentId/$threadId", params: chat }).catch((error) => {
          console.error("Could not open the monitoring fix chat", error);
        });
      } else {
        setStored({
          ...state,
          pending: false,
          failure: isAtomCommandInterrupted(result)
            ? null
            : monitoringFixChatFailureMessage(result.cause),
        });
      }
    });
  };
  return { code, available: target !== null && available, pending, failure, started, start };
}
