import { useAtomValue } from "@effect/atom-react";
import type {
  OrchestrationV2RestartHoldTurn,
  OrchestrationV2RestartHoldWork,
} from "@t3tools/contracts";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { type ReactNode, type RefObject, useRef } from "react";

import { useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import {
  type RunningCommand,
  type RunningThread,
  runningCommandCountAtom,
  runningCommandsAtom,
  runningThreadCountAtom,
  runningThreadsAtom,
  splitRunningThreadsForRestart,
} from "./runningThreads";
import {
  useHostedRestartHoldKey,
  useRestartHoldWork,
  useRestartHoldWorkCount,
} from "./localInstallWait";
import { isHostedByThisApp } from "./useUpdateEverything";
import { splitRestartHoldWork } from "../restartHold.logic";

import { t, tx } from "~/i18n";
const LISTED_THREADS = 5;

/**
 * Threads running, and background work waited on, on the servers this desktop app restarts when
 * it installs an update. Watches them only while an update is `ready` to install, since the
 * counts update with every thread.
 */
export function useThisAppRunningThreads(ready: boolean) {
  const { environments } = useEnvironments();
  const key = ready
    ? environmentIdsKey(
        environments.filter(isHostedByThisApp).map(({ environmentId }) => environmentId),
      )
    : "";
  const count = useAtomValue(runningThreadCountAtom(key));
  const commandCount = useAtomValue(runningCommandCountAtom(key));
  const holdCount = useRestartHoldWorkCount(useHostedRestartHoldKey(ready));
  return { key, count, commandCount, busy: count > 0 || commandCount > 0 || holdCount > 0 };
}

export function SafeUpdateDialog({
  open,
  onOpenChange,
  version,
  environmentIds,
  onConfirm,
  onConfirmWhenIdle,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly version: string | null;
  /** An `environmentIdsKey` of the servers that restart. */
  readonly environmentIds: string;
  /** Installs now, stopping any background work. */
  readonly onConfirm: () => void;
  /** Installs once no chat waits on background work. */
  readonly onConfirmWhenIdle: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup
        className="sm:max-w-lg"
        initialFocus={cancelRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <SafeUpdateDialogContent
          version={version}
          environmentIds={environmentIds}
          onConfirm={onConfirm}
          onConfirmWhenIdle={onConfirmWhenIdle}
          cancelRef={cancelRef}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SafeUpdateDialogContent({
  version,
  environmentIds,
  onConfirm,
  onConfirmWhenIdle,
  cancelRef,
}: {
  readonly version: string | null;
  readonly environmentIds: string;
  readonly onConfirm: () => void;
  readonly onConfirmWhenIdle: () => void;
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
}) {
  const { resuming, waitingOnYou } = splitRunningThreadsForRestart(
    useAtomValue(runningThreadsAtom(environmentIds)),
  );
  const commands = useAtomValue(runningCommandsAtom(environmentIds));
  const work = useRestartHoldWork(useHostedRestartHoldKey());
  const { background, turnCalls } = splitRestartHoldWork(work);
  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>
          {version !== null
            ? tx("Safe update to {version}?", {
                version: <span className="font-mono">{version}</span>,
              })
            : t("Safe update?")}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {t(
            "T3.CodeShip saves where each running chat is, installs the update and restarts, then resumes every chat automatically.",
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ScrollArea scrollFade>
        <div className="flex flex-col gap-4 px-6 pb-4 text-sm">
          <BackgroundWorkGroup
            title={t("Waits for background work")}
            note={t(
              "The update installs when this work finishes, even if chats have started more by then. Restarting now stops it.",
            )}
            work={background}
          />
          <BackgroundWorkGroup
            title={t("Waits for running tool calls")}
            note={t(
              "The update installs once each of these chats has no tool call running, so none is cut halfway. Restarting now stops them.",
            )}
            work={turnCalls}
          />
          <CommandGroup commands={commands} />
          <ThreadGroup title={t("Resume after the restart")} threads={resuming} />
          <ThreadGroup
            title={t("Waiting for your answer")}
            note={t("These stop, and need a reply after the restart.")}
            threads={waitingOnYou}
          />
        </div>
      </ScrollArea>
      <AlertDialogFooter>
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" />}>
          {t("Cancel")}
        </AlertDialogClose>
        {work.length > 0 ? (
          <>
            <Button variant="outline" onClick={onConfirm}>
              {t("Update now")}
            </Button>
            <Button onClick={onConfirmWhenIdle}>{t("Update when it finishes")}</Button>
          </>
        ) : (
          <Button onClick={onConfirm}>{t("Safe update")}</Button>
        )}
      </AlertDialogFooter>
    </>
  );
}

/** A titled list that shows the first few entries and counts the rest. */
function EntryGroup({
  title,
  note,
  entries,
}: {
  readonly title: string;
  readonly note?: string;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly content: ReactNode }>;
}) {
  if (entries.length === 0) return null;
  const hidden = entries.length - LISTED_THREADS;
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="font-medium text-muted-foreground text-xs">
        {title} · {entries.length}
      </h3>
      {note !== undefined ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      <ul className="flex min-w-0 flex-col gap-0.5">
        {entries.slice(0, LISTED_THREADS).map(({ key, content }) => (
          <li key={key} className="truncate">
            {content}
          </li>
        ))}
        {hidden > 0 ? (
          <li className="text-muted-foreground">{t("and {count} more", { count: hidden })}</li>
        ) : null}
      </ul>
    </section>
  );
}

function ThreadGroup({
  title,
  note,
  threads,
}: {
  readonly title: string;
  readonly note?: string;
  readonly threads: ReadonlyArray<RunningThread>;
}) {
  return (
    <EntryGroup
      title={title}
      {...(note !== undefined ? { note } : {})}
      entries={threads.map(({ environmentId, thread }) => ({
        key: `${environmentId}:${thread.id}`,
        content: thread.title,
      }))}
    />
  );
}

function CommandGroup({ commands }: { readonly commands: ReadonlyArray<RunningCommand> }) {
  return (
    <EntryGroup
      title={t("Carry on through the update")}
      note={t(
        "T3.CodeShip runs these commands outside the chats, so the restart does not stop them. Each tells its chat when it finishes.",
      )}
      entries={commands.map(({ environmentId, thread, task }) => ({
        key: `${environmentId}:${task.taskId}`,
        content: (
          <>
            {task.description === undefined ? (
              t("Command")
            ) : (
              <span className="font-mono">{commandDisplayText(task.description)}</span>
            )}{" "}
            <span className="text-muted-foreground">{thread.title}</span>
          </>
        ),
      }))}
    />
  );
}

/** Chats whose turn is running, which an automatic install waits for. */
export function RunningTurnsGroup({
  title,
  turns,
}: {
  readonly title: string;
  readonly turns: ReadonlyArray<OrchestrationV2RestartHoldTurn>;
}) {
  return (
    <EntryGroup
      title={title}
      entries={turns.map((turn) => ({ key: turn.threadId, content: turn.threadTitle }))}
    />
  );
}

/** What chats wait on: the task, then the chat that waits. */
export function BackgroundWorkGroup({
  title,
  note,
  work,
}: {
  readonly title: string;
  readonly note?: string;
  readonly work: ReadonlyArray<OrchestrationV2RestartHoldWork>;
}) {
  return (
    <EntryGroup
      title={title}
      {...(note !== undefined ? { note } : {})}
      entries={work.map((entry, index) => ({
        key: `${entry.threadId}:${index}`,
        content: (
          <>
            {entry.label} <span className="text-muted-foreground">{entry.threadTitle}</span>
          </>
        ),
      }))}
    />
  );
}
