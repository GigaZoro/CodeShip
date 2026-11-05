import type {
  PullRequestActivity,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestDetail,
  PullRequestListEntry,
  PullRequestMergeability,
} from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import { t, tn, msg } from "../../lib/i18n";

const STATES = {
  open: {
    label: msg("Open"),
    icon: PullRequestGlyph.pullRequest,
    tint: "accent-adaptive-emerald-600-400",
    text: "text-adaptive-emerald-600-400",
    background: "bg-adaptive-emerald-500-a12-a16",
  },
  merged: {
    label: msg("Merged"),
    icon: PullRequestGlyph.merged,
    tint: "accent-adaptive-violet-600-400",
    text: "text-adaptive-violet-600-400",
    background: "bg-adaptive-violet-500-a12-a16",
  },
  closed: {
    label: msg("Closed"),
    icon: PullRequestGlyph.closed,
    tint: "accent-danger-foreground",
    text: "text-danger-foreground",
    background: "bg-danger",
  },
  draft: {
    label: msg("Draft"),
    icon: PullRequestGlyph.draft,
    tint: "accent-icon-muted",
    text: "text-foreground-muted",
    background: "bg-grouped-card",
  },
} satisfies Record<
  string,
  { label: string; icon: AppSymbolName; tint: string; text: string; background: string }
>;

export function pullRequestStatus(pr: Pick<PullRequestListEntry, "state" | "isDraft">) {
  const status = STATES[pr.isDraft && pr.state === "open" ? "draft" : pr.state];
  return { ...status, label: t(status.label) };
}

export function pullRequestConflict(pr: {
  readonly state: PullRequestListEntry["state"];
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability | undefined;
  readonly baseBranch?: string | undefined;
}) {
  if (pr.state !== "open" || pr.isDraft || pr.mergeability !== "conflicting") return null;
  return {
    label: pr.baseBranch
      ? t("Conflicts with {branch}", { branch: pr.baseBranch })
      : t("Has conflicts"),
  };
}

export function checkStatus(check: PullRequestCheck) {
  switch (check.status) {
    case "success":
      return {
        label: t("Passed"),
        icon: "checkmark.circle",
        tint: "accent-adaptive-emerald-600-400",
      } as const;
    case "failure":
      return {
        label: t("Failed"),
        icon: "exclamationmark.circle",
        tint: "accent-danger-foreground",
      } as const;
    case "action-required":
      return {
        label: t("Action required"),
        icon: "exclamationmark.circle",
        tint: "accent-warning-foreground",
      } as const;
    case "pending":
      return { label: t("Pending"), icon: "clock", tint: "accent-warning-foreground" } as const;
    case "cancelled":
      return { label: t("Cancelled"), icon: "minus", tint: "accent-icon-muted" } as const;
    case "skipped":
      return { label: t("Skipped"), icon: "slash.circle", tint: "accent-icon-muted" } as const;
    case "neutral":
      return { label: t("Neutral"), icon: "minus", tint: "accent-icon-muted" } as const;
  }
}

export function pullRequestChecksSummary(pr: Pick<PullRequestDetail, "checks">) {
  const failed = pr.checks.filter((check) => check.status === "failure").length;
  const required = pr.checks.filter((check) => check.status === "action-required").length;
  const pending = pr.checks.filter((check) => check.status === "pending").length;
  const passed = pr.checks.filter((check) => check.status === "success").length;
  const count = pr.checks.length
    ? t("{passed} of {total}", { passed, total: pr.checks.length })
    : undefined;
  if (failed)
    return {
      label: tn(failed, "{count} check failing", "{count} checks failing"),
      title: tn(failed, "{count} check failing", "{count} checks failing"),
      count,
      icon: "exclamationmark.circle",
      tint: "accent-danger-foreground",
    } as const;
  if (required)
    return {
      label: t("{count} need attention", { count: required }),
      title: t("Checks need attention"),
      count: t("{count} awaiting action", { count: required }),
      icon: "exclamationmark.circle",
      tint: "accent-warning-foreground",
    } as const;
  if (pending)
    return {
      label: t("{count} pending", { count: pending }),
      title: t("Checks running"),
      count: t("{count} pending", { count: pending }),
      icon: "clock",
      tint: "accent-warning-foreground",
    } as const;
  if (passed)
    return {
      label: t("{passed} of {total} passed", { passed, total: pr.checks.length }),
      title: passed === pr.checks.length ? t("All checks passed") : t("Checks completed"),
      count,
      icon: "checkmark.circle",
      tint: "accent-adaptive-emerald-600-400",
    } as const;
  return {
    label: pr.checks.length
      ? t("{count} completed", { count: pr.checks.length })
      : t("No checks reported"),
    title: pr.checks.length ? t("Checks completed") : t("No checks reported"),
    count,
    icon: "minus",
    tint: "accent-icon-muted",
  } as const;
}

// GitHub and Forgejo send uppercase review states; Bitbucket and GitCafe send lowercase.
export function normalizedReviewState(reviewState: string | null) {
  return reviewState?.toUpperCase().replaceAll("-", "_");
}

export function pullRequestReviewSummary(
  pr: Pick<PullRequestDetail, "reviewers">,
  activity: Pick<PullRequestActivity, "comments" | "commits"> | null,
) {
  const latest = new Map<string, PullRequestActivity["comments"][number]>();
  const comments = new Map<string, PullRequestActivity["comments"][number]>();
  for (const review of activity?.comments ?? []) {
    const state = normalizedReviewState(review.reviewState);
    if (review.kind !== "review" || !state) continue;
    const key = review.author?.login ?? review.id;
    if (state === "COMMENTED") {
      const previous = comments.get(key);
      if (!previous || Date.parse(review.createdAt) >= Date.parse(previous.createdAt))
        comments.set(key, { ...review, reviewState: state });
      continue;
    }
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    const previous = latest.get(key);
    if (!previous || Date.parse(review.createdAt) >= Date.parse(previous.createdAt))
      latest.set(key, { ...review, reviewState: state });
  }
  const reviews = [
    ...[...latest.values()].filter((review) => review.reviewState !== "DISMISSED"),
    ...[...comments.entries()].filter(([key]) => !latest.has(key)).map(([, review]) => review),
  ];
  const requested = reviews.filter((review) => review.reviewState === "CHANGES_REQUESTED");
  const newestCommit = Math.max(
    0,
    ...(activity?.commits.map((commit) => Date.parse(commit.committedDate)) ?? []),
  );
  const approved = reviews.filter(
    (review) => review.reviewState === "APPROVED" && Date.parse(review.createdAt) >= newestCommit,
  );
  if (requested.length)
    return {
      title: t("Changes requested"),
      count: tn(requested.length, "{count} reviewer", "{count} reviewers"),
      icon: "xmark.circle.fill",
      tint: "accent-danger-foreground",
      reviews,
    } as const;
  if (approved.length)
    return {
      title:
        approved.length === 1 && approved[0]?.author
          ? t("Approved by {name}", { name: approved[0].author.login })
          : t("Reviews approved"),
      count: t("{count} approved", { count: approved.length }),
      icon: "checkmark.circle",
      tint: "accent-adaptive-emerald-600-400",
      reviews,
    } as const;
  const commented = reviews.filter((review) => review.reviewState === "COMMENTED");
  if (commented.length && !pr.reviewers.length)
    return {
      title: t("Reviews"),
      count: t("{count} commented", { count: commented.length }),
      icon: "bubble.left",
      tint: "accent-icon-muted",
      reviews,
    } as const;
  return {
    title: pr.reviewers.length ? t("Awaiting review") : t("Request a review"),
    count: pr.reviewers.length
      ? t("{count} requested", { count: pr.reviewers.length })
      : t("None assigned"),
    icon: "person.2",
    tint: "accent-icon-muted",
    reviews,
  } as const;
}

export function pullRequestBranchSummary(
  pr: Pick<PullRequestDetail, "mergeability" | "baseComparison" | "behindBy" | "baseBranch">,
) {
  if (pr.mergeability === "conflicting") return t("Has conflicts");
  if (pr.baseComparison === "behind")
    return pr.behindBy != null
      ? t("{count} behind {branch}", { count: pr.behindBy, branch: pr.baseBranch })
      : t("Behind {branch}", { branch: pr.baseBranch });
  if (pr.baseComparison === "up-to-date") return t("Up to date");
  return pr.mergeability === "mergeable" ? t("No conflicts") : t("Not reported");
}

export function pullRequestChecksStatus(state: PullRequestChecksState) {
  if (state === "passing")
    return { icon: "checkmark.circle", tint: "accent-adaptive-emerald-600-400" } as const;
  if (state === "failing")
    return { icon: "xmark.circle.fill", tint: "accent-danger-foreground" } as const;
  return { icon: "clock", tint: "accent-warning-foreground" } as const;
}
