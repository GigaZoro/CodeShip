import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  CommandId,
  type EnvironmentId,
  type MonitoringFindingCode,
  type MonitoringOverviewInput,
  type MonitoringThreadDetail,
  type ThreadId,
} from "@t3tools/contracts";
import {
  mergeMonitoringOverviews,
  type MonitoringEnvironmentReport,
  type MonitoringFixChatTarget,
  type MonitoringOverviewView,
} from "@t3tools/client-runtime/monitoring";
import { monitoringFixChatFailureMessage } from "@t3tools/client-runtime/monitoring-text";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/** Connected environments answer; their chats merge. A chat stays in the list while it refreshes. */
const monitoringOverviewAtom = Atom.family((inputKey: string) =>
  Atom.make((get): MonitoringOverviewView => {
    const input = JSON.parse(inputKey) as MonitoringOverviewInput;
    const reports: MonitoringEnvironmentReport[] = [];
    for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
      if (presentation.connection.phase !== "connected") continue;
      const result = get(serverEnvironment.monitoringOverview({ environmentId, input }));
      reports.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
        result: AsyncResult.getOrElse(result, () => null),
      });
    }
    return mergeMonitoringOverviews(reports);
  }).pipe(Atom.withLabel(`web-monitoring:overview:${inputKey}`)),
);

export function useMonitoringOverview(input: MonitoringOverviewInput): MonitoringOverviewView {
  return useAtomValue(monitoringOverviewAtom(JSON.stringify(input)));
}

export function refreshMonitoringOverview(
  environmentIds: ReadonlyArray<EnvironmentId>,
  input: MonitoringOverviewInput,
) {
  for (const environmentId of environmentIds) {
    appAtomRegistry.refresh(serverEnvironment.monitoringOverview({ environmentId, input }));
  }
}

export interface MonitoringThreadView {
  readonly detail: MonitoringThreadDetail | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export function useMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
): MonitoringThreadView {
  const result = useAtomValue(
    serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
  );
  return {
    detail: AsyncResult.getOrElse(result, () => null),
    isPending: result.waiting,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
  };
}

export function refreshMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
) {
  appAtomRegistry.refresh(
    serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
  );
}

const NO_FIX_CHAT_PERMISSION_ATOM = Atom.make(false).pipe(
  Atom.withLabel("web-monitoring:fix-chat:none"),
);

export interface MonitoringFixChat {
  /** False when no chat shows the weak point or this client may not start chats on its machine. */
  readonly available: boolean;
  readonly pending: boolean;
  readonly failure: string | null;
  /** The chat this button started, linked for when the user moved on before it opened. */
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
  const allowed = useAtomValue(
    target === null
      ? NO_FIX_CHAT_PERMISSION_ATOM
      : serverEnvironment.startMonitoringFixChat.permissionAtom(target.environmentId),
  );
  const navigate = useNavigate();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [started, setStarted] = useState<MonitoringFixChat["started"]>(null);
  // A retry keeps the failed attempt's id, so a start whose answer was lost opens that chat.
  const commandId = useRef<CommandId | null>(null);
  const start = () => {
    if (target === null || pending) return;
    const { environmentId } = target;
    const id = commandId.current ?? CommandId.make(randomUUID());
    commandId.current = id;
    setPending(true);
    setFailure(null);
    const startedAt = router.state.location.pathname;
    void run({
      environmentId,
      input: { commandId: id, creationSource: "web", code, threadIds: target.threadIds },
    }).then((result) => {
      setPending(false);
      if (result._tag === "Success") {
        commandId.current = null;
        const chat = { environmentId, threadId: result.value.threadId };
        setStarted(chat);
        // The chat opens only where the user asked for it; elsewhere the row links to it.
        if (router.state.location.pathname !== startedAt) return;
        void navigate({ to: "/$environmentId/$threadId", params: chat });
      } else if (!isAtomCommandInterrupted(result)) {
        setFailure(monitoringFixChatFailureMessage(result.cause));
      }
    });
  };
  return { available: target !== null && allowed, pending, failure, started, start };
}
