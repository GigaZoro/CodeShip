import type { EnvironmentId, ThreadPullRequestLink } from "@t3tools/contracts";
import { CircleXIcon, GitBranchIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useSidebarMachines } from "../sidebar/useSidebarMachines";
import { Button } from "../ui/button";
import { PopoverTrigger, type PopoverCreateHandle } from "../ui/popover";
import { DiffStatLabel } from "./DiffStatLabel";
import { resolveThreadVitals, type ThreadVital } from "./threadVitals";
import { t } from "~/i18n";

/** The thread's state in one header line while its details are closed; it opens them floating. */
export function ThreadVitalsStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly contextUsedPercentage: number | null;
  readonly handle: ReturnType<typeof PopoverCreateHandle>;
}) {
  const machine = useSidebarMachines().find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  // The same query the details card reads, so opening it shows no second load.
  const { data: status } = useEnvironmentQuery(
    props.isGitRepo && props.gitCwd !== null
      ? vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: props.gitCwd } })
      : null,
  );
  const changes = status ? (status.branchChanges ?? status.workingTree) : null;
  const vitals = resolveThreadVitals({
    machineLabel: machine?.label ?? null,
    branch: status?.refName ?? null,
    changes: changes ? { additions: changes.insertions, deletions: changes.deletions } : null,
    branchPullRequest: status?.refName && status.pr ? status.pr : null,
    linkedPullRequests: props.pullRequests.flatMap((link) =>
      link.snapshot
        ? [
            {
              number: link.number,
              state: link.snapshot.state,
              checksFailing: link.snapshot.checksState === "failing",
            },
          ]
        : [],
    ),
    contextUsedPercentage: props.contextUsedPercentage,
  });
  if (vitals.length === 0) return null;
  return (
    <PopoverTrigger
      handle={props.handle}
      data-thread-vitals
      render={<Button variant="ghost-muted" size="xs" />}
      className="hidden min-w-0 shrink overflow-hidden @2xl/chat-header:inline-flex [-webkit-app-region:no-drag]"
    >
      <span className="sr-only">{t("Thread details:")} </span>
      {vitals.map((vital, index) => (
        <Fragment key={vital.kind}>
          {index > 0 ? <span aria-hidden>·</span> : null}
          <VitalSegment vital={vital} />
        </Fragment>
      ))}
    </PopoverTrigger>
  );
}

function VitalSegment({ vital }: { vital: ThreadVital }) {
  switch (vital.kind) {
    case "machine":
      return <span className="max-w-32 truncate">{vital.label}</span>;
    case "branch":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate">{vital.name}</span>
        </span>
      );
    case "changes":
      return (
        <DiffStatLabel layout="inline" additions={vital.additions} deletions={vital.deletions} />
      );
    case "pullRequest":
      return (
        <span className="shrink-0 tabular-nums">{t("PR #{number}", { number: vital.number })}</span>
      );
    case "checksFailing":
      return (
        <span className="flex shrink-0 items-center gap-1 text-destructive-foreground">
          <CircleXIcon aria-hidden className="size-3.5" />
          {t("Checks failing")}
        </span>
      );
    case "context":
      return (
        <span
          className={
            vital.attention
              ? "flex shrink-0 items-center gap-1 tabular-nums text-warning-foreground"
              : "shrink-0 tabular-nums"
          }
        >
          {vital.attention ? <TriangleAlertIcon aria-hidden className="size-3.5" /> : null}
          {t("{percent}% context", { percent: vital.percent })}
        </span>
      );
  }
}
