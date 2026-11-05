import { useAtomValue } from "@effect/atom-react";
import { type RefObject, useRef } from "react";

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
  type RunningThread,
  runningThreadCountAtom,
  runningThreadsAtom,
  splitRunningThreadsForRestart,
} from "./runningThreads";
import { isHostedByThisApp } from "./useUpdateEverything";

const LISTED_THREADS = 5;

/**
 * Threads running on the servers this desktop app restarts when it installs an update. Watches
 * them only while an update is `ready` to install, since the count updates with every thread.
 */
export function useThisAppRunningThreads(ready: boolean) {
  const { environments } = useEnvironments();
  const key = ready
    ? environmentIdsKey(
        environments.filter(isHostedByThisApp).map(({ environmentId }) => environmentId),
      )
    : "";
  return { key, count: useAtomValue(runningThreadCountAtom(key)) };
}

export function SafeUpdateDialog({
  open,
  onOpenChange,
  version,
  environmentIds,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly version: string | null;
  /** An `environmentIdsKey` of the servers that restart. */
  readonly environmentIds: string;
  readonly onConfirm: () => void;
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
  cancelRef,
}: {
  readonly version: string | null;
  readonly environmentIds: string;
  readonly onConfirm: () => void;
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
}) {
  const { resuming, waitingOnYou } = splitRunningThreadsForRestart(
    useAtomValue(runningThreadsAtom(environmentIds)),
  );
  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>
          Safe update
          {version !== null ? (
            <>
              {" "}
              to <span className="font-mono">{version}</span>
            </>
          ) : null}
          ?
        </AlertDialogTitle>
        <AlertDialogDescription>
          T3.CodeShip saves where each running chat is, installs the update and restarts, then
          resumes every chat automatically.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ScrollArea scrollFade>
        <div className="flex flex-col gap-4 px-6 pb-4 text-sm">
          <ThreadGroup title="Resume after the restart" threads={resuming} />
          <ThreadGroup
            title="Waiting for your answer"
            note="These stop, and need a reply after the restart."
            threads={waitingOnYou}
          />
        </div>
      </ScrollArea>
      <AlertDialogFooter>
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" />}>
          Cancel
        </AlertDialogClose>
        <Button onClick={onConfirm}>Safe update</Button>
      </AlertDialogFooter>
    </>
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
  if (threads.length === 0) return null;
  const hidden = threads.length - LISTED_THREADS;
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="font-medium text-muted-foreground text-xs">
        {title} · {threads.length}
      </h3>
      {note !== undefined ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      <ul className="flex min-w-0 flex-col gap-0.5">
        {threads.slice(0, LISTED_THREADS).map(({ environmentId, thread }) => (
          <li key={`${environmentId}:${thread.id}`} className="truncate">
            {thread.title}
          </li>
        ))}
        {hidden > 0 ? <li className="text-muted-foreground">and {hidden} more</li> : null}
      </ul>
    </section>
  );
}
