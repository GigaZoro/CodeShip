import {
  manualStepChatHost,
  manualStepsFailureMessage,
  detectedManualStepKey,
  type DetectedManualStepEntry,
  type ManualStepChatHost,
  type ManualStepGroup,
  type ManualStepsView,
} from "@t3tools/client-runtime/state/manualSteps";
import { signInWalkEntries } from "@t3tools/client-runtime/state/manualStepsSignIn.logic";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { lazy, Suspense, useId, useState, type KeyboardEvent, type MouseEvent } from "react";

import { attachSidebarTree } from "../../lib/sidebarTree";
import { cn } from "../../lib/utils";
import { useManualSteps } from "../../state/manualSteps";
import { searchableSetting } from "../settings/settingsSearch";
import { detectedStepText, useOpenDetectedStep } from "./detectedManualStep";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ManualStepCard } from "./ManualStepCard";
import { t } from "~/i18n";

// The guided sign-in carries the provider and MCP sign-in flows, which most visits never open.
const SignInAllDialog = lazy(() => import("./SignInAllDialog"));

/** Settings → Threads, at the ThreadPage token. */
function ConnectThreadPageLink(props: { readonly size?: "xs" | "sm" }) {
  return (
    <Button
      size={props.size ?? "sm"}
      variant="outline"
      render={<Link to="/settings/threads" hash={searchableSetting("threadpage-token").id} />}
    >
      {t("Connect ThreadPage")}
    </Button>
  );
}

function stopRowActivation(event: MouseEvent) {
  event.stopPropagation();
}

/** A sign-in this machine noticed itself; the button opens the account or MCP server that fixes it. */
function DetectedStepRow(props: {
  readonly entry: DetectedManualStepEntry;
  readonly onOpen: (entry: DetectedManualStepEntry) => void;
}) {
  const { entry } = props;
  const text = detectedStepText(entry);
  const lapsed = entry.step.kind === "login-expired";
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    props.onOpen(entry);
  };
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`detected-step:${detectedManualStepKey(entry)}`}
        aria-label={[text.step, text.detail].join(", ")}
        onClick={() => props.onOpen(entry)}
        onKeyDown={handleKeyDown}
        className="cursor-pointer rounded-md px-2 py-1.5 text-left outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          <KeyRoundIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              lapsed ? "text-destructive-foreground" : "text-warning-foreground",
            )}
          />
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate text-sm">{text.step}</span>}
            />
            <TooltipPopup side="top">{text.step}</TooltipPopup>
          </Tooltip>
          <span className="shrink-0" onClick={stopRowActivation}>
            <Button size="xs" variant="outline" onClick={() => props.onOpen(entry)}>
              {entry.step.kind === "connected-app-cap" ? t("Switch sign-in") : t("Sign in")}
            </Button>
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 ps-5 text-xs text-muted-foreground">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              lapsed ? "font-medium text-destructive-foreground" : "",
            )}
          >
            {text.detail}
          </span>
        </div>
      </div>
    </li>
  );
}

type StartSignInWalk = (entries: ReadonlyArray<DetectedManualStepEntry>) => void;

/** A machine with several sign-ins to do gets one place to walk through all of them. */
function SignInAllRow(props: {
  readonly entries: ReadonlyArray<DetectedManualStepEntry>;
  readonly onStart: StartSignInWalk;
}) {
  const label = t("Sign in to all ({count})", { count: props.entries.length });
  const start = () => props.onStart(props.entries);
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    start();
  };
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`sign-in-all:${props.entries[0]?.environmentId ?? ""}:${props.entries[0]?.step.machine ?? ""}`}
        aria-label={label}
        onClick={start}
        onKeyDown={handleKeyDown}
        className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span onClick={stopRowActivation}>
          <Button size="xs" variant="outline" onClick={start}>
            <KeyRoundIcon aria-hidden />
            {label}
          </Button>
        </span>
      </div>
    </li>
  );
}

const hasSeveralSignIns = (group: ManualStepGroup) => signInWalkEntries(group.detected).length >= 2;

function ManualStepsSkeleton() {
  return (
    <div aria-hidden className="grid gap-2 px-2 py-1.5">
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/** Detected sign-ins can list while ThreadPage fails; this says why its steps are missing. */
function ThreadPageIssueNote(props: { readonly view: ManualStepsView }) {
  if (props.view.status !== "listed" || props.view.threadPageIssue === undefined) return null;
  return (
    <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
      {t("ThreadPage steps are not shown. {reason}", {
        reason: manualStepsFailureMessage(props.view.threadPageIssue),
      })}
    </p>
  );
}

/** Why the page shows no list: still loading, not connected, failed, or nothing to do. */
function ManualStepsBody(props: { readonly view: ManualStepsView; readonly onRetry: () => void }) {
  const { view } = props;
  if (view.status === "loading") return <ManualStepsSkeleton />;
  if (view.status === "not-connected") {
    return (
      <div className="grid justify-items-start gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <p>{t("Connect ThreadPage to see the steps only you can do, from every machine.")}</p>
        <ConnectThreadPageLink size="xs" />
      </div>
    );
  }
  if (view.status === "failed") {
    return (
      <div role="alert" className="grid justify-items-start gap-2 px-2 py-1.5 text-xs">
        <p className="text-destructive-foreground">{manualStepsFailureMessage(view.reason)}</p>
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={props.onRetry}>
            {t("Retry")}
          </Button>
          {view.reason === "token-rejected" || view.reason === "access-denied" ? (
            <ConnectThreadPageLink size="xs" />
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <p className="px-2 py-1.5 text-xs text-muted-foreground">
      {t("Nothing needs your hands right now")}
    </p>
  );
}

function ManualStepsMachineSection(props: {
  readonly group: ManualStepGroup;
  readonly reviewEnvironmentId: EnvironmentId | null;
  readonly chatHosts: ReadonlyArray<ManualStepChatHost>;
  readonly selectedThreadId: string | undefined;
  readonly onStartSignInWalk: StartSignInWalk;
}) {
  const { group } = props;
  const chatHost = manualStepChatHost(props, group.machine);
  const headingId = useId();
  const openDetected = useOpenDetectedStep();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="px-1 pb-2 text-xs font-medium text-muted-foreground">
        {group.machine}
      </h2>
      {group.detected.length > 0 ? (
        <ul
          ref={attachSidebarTree}
          aria-label={t("Sign-ins on {machine}", { machine: group.machine })}
          className="mb-3 flex flex-col gap-px rounded-2xl border border-border/70 bg-sidebar p-1.5 text-sidebar-foreground"
        >
          {hasSeveralSignIns(group) ? (
            <SignInAllRow
              entries={signInWalkEntries(group.detected)}
              onStart={props.onStartSignInWalk}
            />
          ) : null}
          {group.detected.map((entry) => (
            <DetectedStepRow
              key={detectedManualStepKey(entry)}
              entry={entry}
              onOpen={openDetected}
            />
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-3">
        {group.steps.map((step) => (
          <ManualStepCard
            key={step.threadId}
            step={step}
            reviewEnvironmentId={props.reviewEnvironmentId}
            chatHost={chatHost}
            selected={step.threadId === props.selectedThreadId}
          />
        ))}
      </ul>
    </section>
  );
}

/** Every step with its review, grouped by machine. */
function ManualStepsPageList(props: {
  readonly groups: ReadonlyArray<ManualStepGroup>;
  readonly reviewEnvironmentId: EnvironmentId | null;
  readonly chatHosts: ReadonlyArray<ManualStepChatHost>;
  readonly selectedThreadId: string | undefined;
  readonly onStartSignInWalk: StartSignInWalk;
}) {
  return (
    <div className="flex flex-col gap-4">
      {props.groups.map((group) => (
        <ManualStepsMachineSection
          key={group.machine}
          group={group}
          reviewEnvironmentId={props.reviewEnvironmentId}
          chatHosts={props.chatHosts}
          selectedThreadId={props.selectedThreadId}
          onStartSignInWalk={props.onStartSignInWalk}
        />
      ))}
    </div>
  );
}

/** The whole list, for the Manual steps page. */
export function ManualStepsPageContent() {
  // The walk keeps the sign-ins it started with and lives beside the list, since finishing one
  // refreshes the list, which can drop the row that opened it.
  const [signInWalk, setSignInWalk] = useState<ReadonlyArray<DetectedManualStepEntry> | null>(null);
  return (
    <>
      <ManualStepsPageBody onStartSignInWalk={setSignInWalk} />
      {signInWalk === null ? null : (
        <Suspense fallback={null}>
          <SignInAllDialog entries={signInWalk} onClose={() => setSignInWalk(null)} />
        </Suspense>
      )}
    </>
  );
}

function ManualStepsPageBody(props: { readonly onStartSignInWalk: StartSignInWalk }) {
  const { state, refresh } = useManualSteps();
  const { step: selectedThreadId } = useSearch({ from: "/_chat/manual-steps" });
  if (state === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No connected machine can read ThreadPage. Update T3.CodeShip on one of them.")}
      </p>
    );
  }
  const { view } = state;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Steps only you can do. Sign-ins each machine notices itself come first; the rest are every machine's pending list in ThreadPage, each reviewed for whether it needs you, with ways to get it done. Choose a way, or write your own decision, and a chat carries it out. Replying in a step's ThreadPage thread tells that machine to check it again.",
          )}
        </p>
        <Button size="sm" variant="outline" disabled={state.refreshing} onClick={refresh}>
          <RefreshIcon size="sm" refreshing={state.refreshing} />
          {t("Refresh")}
        </Button>
      </div>
      {view.status === "listed" && view.count > 0 ? (
        <>
          <ManualStepsPageList
            groups={view.groups}
            reviewEnvironmentId={view.reviewEnvironmentId}
            chatHosts={view.chatHosts}
            selectedThreadId={selectedThreadId}
            onStartSignInWalk={props.onStartSignInWalk}
          />
          <ThreadPageIssueNote view={view} />
        </>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-sidebar p-1.5 text-sidebar-foreground">
          <ManualStepsBody view={view} onRetry={refresh} />
        </div>
      )}
    </div>
  );
}
