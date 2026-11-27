/** Context use the strip shows at all; below it the number is noise. */
const CONTEXT_VITAL_PERCENT = 60;
/** Context use the strip marks as needing attention. */
const CONTEXT_ATTENTION_PERCENT = 80;

export type ThreadVital =
  | { readonly kind: "machine"; readonly label: string }
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "changes"; readonly additions: number; readonly deletions: number }
  | { readonly kind: "pullRequest"; readonly number: number }
  | { readonly kind: "checksFailing" }
  | { readonly kind: "context"; readonly percent: number; readonly attention: boolean };

export interface ThreadVitalsInput {
  readonly machineLabel: string | null;
  readonly branch: string | null;
  readonly changes: { readonly additions: number; readonly deletions: number } | null;
  /** The pull request the branch's status reports, in any state. */
  readonly branchPullRequest: { readonly number: number; readonly state: string } | null;
  readonly linkedPullRequests: ReadonlyArray<{
    readonly number: number;
    readonly state: string;
    readonly checksFailing: boolean;
  }>;
  readonly contextUsedPercentage: number | null;
}

/** The thread's state in one line: where it runs, what it changed, and what needs a look. */
export function resolveThreadVitals(input: ThreadVitalsInput): ThreadVital[] {
  const vitals: ThreadVital[] = [];
  if (input.machineLabel) vitals.push({ kind: "machine", label: input.machineLabel });
  if (input.branch) vitals.push({ kind: "branch", name: input.branch });
  if (input.changes && (input.changes.additions > 0 || input.changes.deletions > 0)) {
    vitals.push({ kind: "changes", ...input.changes });
  }
  // Only an open pull request is live work; a merged one would hide the follow-up the thread opened.
  const openLinked = input.linkedPullRequests.filter((link) => link.state === "open");
  const pullRequestNumber =
    (input.branchPullRequest?.state === "open" ? input.branchPullRequest.number : undefined) ??
    openLinked[0]?.number;
  if (pullRequestNumber !== undefined) {
    vitals.push({ kind: "pullRequest", number: pullRequestNumber });
    if (openLinked.some((link) => link.number === pullRequestNumber && link.checksFailing)) {
      vitals.push({ kind: "checksFailing" });
    }
  }
  if (input.contextUsedPercentage !== null) {
    const percent = Math.round(Math.min(100, input.contextUsedPercentage));
    if (percent > CONTEXT_VITAL_PERCENT) {
      vitals.push({ kind: "context", percent, attention: percent > CONTEXT_ATTENTION_PERCENT });
    }
  }
  return vitals;
}
