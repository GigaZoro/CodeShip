import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, type RefObject, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { environmentThreadShells } from "~/state/threads";
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
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import {
  type RestartingMachine,
  selectUpdateRows,
  type UpdateEverythingRow,
  type UpdateEverythingSelection,
  updateRowKey,
} from "./updateEverything.logic";

const isRunning = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

const runningThreadCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .reduce(
        (count, id) =>
          count +
          get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).filter(
            (thread) => isRunning(thread.status),
          ).length,
        0,
      ),
  ).pipe(Atom.withLabel(`update-everything-running-threads:${environmentIds}`)),
);

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly version: string | null;
  readonly rows: ReadonlyArray<UpdateEverythingRow>;
  readonly restarts: ReadonlyArray<RestartingMachine>;
  readonly onConfirm: (selection: UpdateEverythingSelection) => void;
  /** Lets the user leave machines out with a checkbox per row. */
  readonly selectable?: boolean;
  /** Overrides the "Update N machines?" title, for an update-track switch. */
  readonly title?: string;
  readonly confirmLabel?: string;
  readonly notes?: ReadonlyArray<string>;
  /** Shown in place of running-thread counts; disables the confirm button. */
  readonly disabledReason?: string | null;
  /** The confirmed work is starting; it cannot be cancelled from here. */
  readonly busy?: boolean;
}

type UpdateEverythingDialogContentProps = Omit<
  UpdateEverythingDialogProps,
  "open" | "onOpenChange"
> & {
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
};

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  ...content
}: UpdateEverythingDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
      <AlertDialogPopup
        className="sm:max-w-xl"
        initialFocus={cancelRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <UpdateEverythingDialogContent {...content} cancelRef={cancelRef} />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const APP_LABELS = {
  "this-app": "This app",
  server: "Server",
  "desktop-app": "Desktop app",
} as const;

function UpdateEverythingDialogContent({
  version,
  rows,
  restarts,
  onConfirm,
  selectable = false,
  cancelRef,
  title,
  confirmLabel = "Update",
  notes = [],
  disabledReason = null,
  busy = false,
}: UpdateEverythingDialogContentProps) {
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  const updating = rows.filter((row) => row.app !== null || row.providers.length > 0);
  const skipped = rows.filter((row) => row.skipped !== null);
  const showCheckboxes = selectable && updating.length > 1;
  const selection = selectUpdateRows(updating, unchecked);
  const selected = updating.filter((row) => !unchecked.has(updateRowKey(row)));
  const providerCount = selected.reduce((count, row) => count + row.providers.length, 0);
  const selectedRestarts = restarts.filter(
    (machine) => !selection.excluded.has(machine.environmentId),
  );
  const toggle = (row: UpdateEverythingRow, checked: boolean) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(updateRowKey(row));
      else next.add(updateRowKey(row));
      return next;
    });
  const stopped = useAtomValue(
    runningThreadCountAtom(
      selectedRestarts
        .filter((machine) => !machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const continuing = useAtomValue(
    runningThreadCountAtom(
      selectedRestarts
        .filter((machine) => machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const running = stopped + continuing;
  const threads = `${running} running ${running === 1 ? "thread" : "threads"}`;
  const restarting = new Set(selectedRestarts.map((machine) => machine.environmentId));

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>
          {title ?? `Update ${selected.length} ${selected.length === 1 ? "machine" : "machines"}?`}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {version !== null ? (
            <>
              CodeShip <span className="font-mono text-xs">{version}</span>
            </>
          ) : null}
          {version !== null && providerCount > 0 ? " · " : null}
          {providerCount > 0
            ? `${providerCount} provider ${providerCount === 1 ? "update" : "updates"}`
            : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ScrollArea scrollFade>
        <div className="flex flex-col gap-3 px-6 pb-4">
          {notes.map((note) => (
            <p key={note} className="text-muted-foreground text-sm">
              {note}
            </p>
          ))}
          {/* Machine names truncate first. Provider lists wrap between names, never inside one. */}
          <div
            className={cn(
              "grid gap-x-4 text-sm",
              showCheckboxes
                ? "grid-cols-[max-content_minmax(4rem,max-content)_max-content_minmax(min-content,1fr)_max-content]"
                : "grid-cols-[minmax(4rem,max-content)_max-content_minmax(min-content,1fr)_max-content]",
            )}
          >
            <div className="col-span-full grid grid-cols-subgrid border-b pb-1.5 text-muted-foreground text-xs">
              {showCheckboxes ? <span /> : null}
              <span>Machine</span>
              <span>CodeShip</span>
              <span>Providers</span>
              <span />
            </div>
            {updating.map((row) => {
              const checked = !unchecked.has(updateRowKey(row));
              const Row = showCheckboxes ? "label" : "div";
              return (
                <Row
                  key={row.environmentId ?? "this-app"}
                  className={cn(
                    "col-span-full grid grid-cols-subgrid border-b border-border/50 py-1.5 last:border-b-0",
                    showCheckboxes && "cursor-pointer",
                    !checked && "text-muted-foreground",
                  )}
                >
                  {showCheckboxes ? (
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={(next) => toggle(row, next)}
                    />
                  ) : null}
                  <span className="max-w-32 min-w-0">
                    <MiddleTruncate value={row.label} />
                  </span>
                  <span>
                    {row.app !== null ? APP_LABELS[row.app] : null}
                    {row.app === null && row.skipped !== null ? (
                      <span className="text-muted-foreground">Skipped</span>
                    ) : null}
                    {row.app === "this-app" ? (
                      <span className="block text-muted-foreground text-xs">restarts last</span>
                    ) : null}
                  </span>
                  <span>
                    {row.providers.map((provider, index) => (
                      <Fragment key={provider}>
                        <span className="whitespace-nowrap">{provider}</span>
                        {index < row.providers.length - 1 ? ", " : null}
                      </Fragment>
                    ))}
                  </span>
                  <span className="text-right">
                    {row.environmentId !== null && restarting.has(row.environmentId) ? (
                      <RunningThreads environmentId={row.environmentId} />
                    ) : null}
                  </span>
                </Row>
              );
            })}
          </div>
          {skipped.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground data-panel-open:[&_svg]:rotate-90">
                <ChevronRightIcon className="size-3.5 transition-transform" aria-hidden />
                {skipped.length} skipped
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="grid grid-cols-[minmax(0,max-content)_1fr] gap-x-3 gap-y-0.5 pt-1.5 ps-4.5 text-muted-foreground text-xs">
                  {skipped.map((row) => (
                    <Fragment key={row.environmentId ?? "this-app"}>
                      <span className="max-w-32 min-w-0">
                        <MiddleTruncate value={row.label} />
                      </span>
                      <span className="wrap-anywhere">{row.skipped}</span>
                    </Fragment>
                  ))}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </div>
      </ScrollArea>
      <AlertDialogFooter>
        {disabledReason !== null ? (
          <p className="self-center text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
            {disabledReason}
          </p>
        ) : running > 0 ? (
          <p className="self-center text-muted-foreground text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
            {stopped === 0
              ? `${threads} will be interrupted and can resume after the restart.`
              : continuing === 0
                ? `${threads} will be interrupted.`
                : `${threads} will be interrupted. ${continuing} can resume after the restart.`}
          </p>
        ) : null}
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" disabled={busy} />}>
          Cancel
        </AlertDialogClose>
        <Button
          disabled={disabledReason !== null || busy || selected.length === 0}
          onClick={() => onConfirm(selection)}
        >
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

function RunningThreads({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const count = useAtomValue(runningThreadCountAtom(environmentId));
  return count > 0 ? <span className="whitespace-nowrap text-warning">{count} running</span> : null;
}
