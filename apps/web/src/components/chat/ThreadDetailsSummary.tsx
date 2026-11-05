import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { useSidebarMachines } from "../sidebar/useSidebarMachines";
import { InlineButton } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
} from "./threadDetailsPanelStyles";
import { t } from "~/i18n";

/**
 * Where the thread works, folded into one control: machine, branch, pull request, and changes.
 * Opening it shows the workspace and Git controls it stands for.
 */
export function ThreadDetailsSummary(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const openPrLink = useOpenPrLink(threadRef);
  const machine =
    useSidebarMachines().find((candidate) => candidate.environmentId === props.environmentId) ??
    null;
  // The same query the Git controls read, so opening them shows no second load.
  const { data: status } = useEnvironmentQuery(
    props.isGitRepo && props.gitCwd !== null
      ? vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: props.gitCwd } })
      : null,
  );
  const changes = status ? (status.branchChanges ?? status.workingTree) : null;
  // It sits over the branch line, so it needs one.
  const pr = status?.refName ? (status.pr ?? null) : null;
  const prState = pr
    ? resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true })
    : null;
  return (
    // The pull request opens from its own button, which a toggle button cannot contain.
    <div className="relative">
      <ThreadDetailsControl
        size="sm"
        variant="ghost"
        part="row"
        multiline
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span className="sr-only">{t("Workspace and Git controls:")} </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 py-1">
          <span className="flex min-w-0 items-center gap-2.5">
            <EnvironmentMachineIcon
              aria-hidden
              kind={machine?.machineKind ?? "server"}
              className={THREAD_DETAILS_PANEL_ICON_CLASS}
            />
            <span className="min-w-0 flex-1 truncate">{machine?.label ?? t("This machine")}</span>
            {changes &&
            hasNonZeroStat({ additions: changes.insertions, deletions: changes.deletions }) ? (
              <DiffStatLabel
                layout="inline"
                additions={changes.insertions}
                deletions={changes.deletions}
                className="text-xs"
              />
            ) : null}
          </span>
          {status?.refName ? (
            <span className="flex min-w-0 items-center gap-2.5 text-xs font-normal text-muted-foreground">
              <GitBranchIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <MiddleTruncate value={status.refName} className="min-w-0 flex-1" />
              {/* An invisible copy of the pull request button holds its room on this line. */}
              {pr && prState ? (
                <span aria-hidden className="invisible inline-flex shrink-0 items-center gap-1">
                  <prState.Icon className="size-3.5" />#{pr.number}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            THREAD_DETAILS_PANEL_CHEVRON_CLASS,
            "transition-transform motion-reduce:transition-none",
            props.expanded && "rotate-180",
          )}
        />
      </ThreadDetailsControl>
      {pr && prState ? (
        <Tooltip>
          <TooltipTrigger
            render={
              // An inline button keeps a small target, so it never takes taps meant for the toggle.
              <InlineButton
                aria-label={t("Open pull request #{number}, {state}: {title}", {
                  number: pr.number,
                  state: prState.label.toLowerCase(),
                  title: pr.title,
                })}
                className="absolute end-9 bottom-2"
                onClick={(event) => openPrLink(event, pr.url, threadRef)}
                onAuxClick={(event) => openPrLink(event, pr.url, threadRef)}
              />
            }
          >
            <span
              className={cn("inline-flex items-center gap-1 tabular-nums", prState.toneClassName)}
            >
              <prState.Icon aria-hidden className="size-3.5" />#{pr.number}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="left" className="max-w-72">
            #{pr.number} · {prState.label}: {pr.title}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
