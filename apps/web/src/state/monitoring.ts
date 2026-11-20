import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  type EnvironmentId,
  type MonitoringFindingCode,
  type MonitoringOverviewInput,
  type MonitoringThreadDetail,
  type ThreadId,
} from "@t3tools/contracts";
import {
  fixChatInput,
  mergeMonitoringOverviews,
  settleFixChat,
  type MonitoringEnvironmentReport,
  type MonitoringFixChatTarget,
  type MonitoringOverviewView,
} from "@t3tools/client-runtime/monitoring";
import { monitoringFixChatFailureMessage } from "@t3tools/client-runtime/monitoring-text";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

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

export interface MonitoringFixChat {
  readonly code: MonitoringFindingCode;
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
    serverEnvironment.startMonitoringFixChat.permissionAtom(target?.environmentId ?? null),
  );
  const navigate = useNavigate();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [started, setStarted] = useState<MonitoringFixChat["started"]>(null);
  const start = () => {
    if (target === null || pending) return;
    const { environmentId } = target;
    setPending(true);
    setFailure(null);
    // The href holds the filters too, so a changed view counts as moving on.
    const startedAt = router.state.location.href;
    void run({ environmentId, input: fixChatInput(target, code, "web", randomUUID) }).then(
      (result) => {
        setPending(false);
        if (result._tag === "Success") {
          settleFixChat(target, code);
          const chat = { environmentId, threadId: result.value.threadId };
          setStarted(chat);
          // The chat opens only where the user asked for it; elsewhere the row links to it.
          if (router.state.location.href !== startedAt) return;
          void navigate({ to: "/$environmentId/$threadId", params: chat });
        } else if (!isAtomCommandInterrupted(result)) {
          setFailure(monitoringFixChatFailureMessage(result.cause));
        }
      },
    );
  };
  return { code, available: target !== null && allowed, pending, failure, started, start };
}
