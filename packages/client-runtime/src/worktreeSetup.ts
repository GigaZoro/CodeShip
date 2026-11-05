import type { WorktreeSetupSnapshot, WorktreeSetupStageId } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  turnStarted: boolean;
  followUpSent: boolean;
}): WorktreeSetupSnapshot | null {
  const snapshot =
    input.live && (!input.recorded || input.live.sequence >= input.recorded.sequence)
      ? input.live
      : input.recorded;
  if (!snapshot) return null;
  if (snapshot.phase === "running") return snapshot;
  if (input.followUpSent) return null;
  if (snapshot.phase !== "done") return snapshot;
  if (!input.turnStarted) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}

export function worktreeSetupStageLabel(id: WorktreeSetupStageId): string {
  switch (id) {
    case "fetch":
      return t("Fetch base branch");
    case "checkout":
      return t("Check out files");
    case "submodules":
      return t("Init submodules");
    case "setup-script":
      return t("Run setup script");
    case "agent":
      return t("Start agent");
  }
}
