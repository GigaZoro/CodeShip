import type { CustomAgentAction } from "@t3tools/contracts/settings";
import { truncate } from "@t3tools/shared/String";
import { MessageSquareTextIcon, ScanSearchIcon, TestTubeDiagonalIcon } from "lucide-react";
import { create } from "zustand";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { msg, t } from "~/i18n";

// The agent reads these as the user's own message, so they say what done looks like.
const AGENT_ACTIONS = [
  {
    id: "ship",
    label: msg("Commit & open PR"),
    icon: PullRequestGlyph.pullRequest,
    needsGit: true,
    needsChanges: true,
    searchTerms: ["commit", "push", "pull request", "pr", "ship"],
    prompt:
      "Commit the changes in this thread with a clear message and push the branch. If it has no pull request yet, open one with a short summary of the changes; otherwise update the existing one.",
  },
  {
    id: "test",
    label: msg("Run tests"),
    icon: TestTubeDiagonalIcon,
    needsGit: false,
    needsChanges: false,
    searchTerms: ["test", "tests", "verify", "check"],
    prompt: "Run the tests that cover the changes in this thread and fix any failures.",
  },
  {
    id: "review",
    label: msg("Review changes"),
    icon: ScanSearchIcon,
    needsGit: false,
    needsChanges: true,
    searchTerms: ["review", "bugs", "check", "audit"],
    prompt:
      "Review the changes in this thread for bugs, missed edge cases and leftover debug code, then fix what you find.",
  },
] as const;

interface AgentAction {
  readonly id: string;
  readonly label: string;
  readonly icon: (typeof AGENT_ACTIONS)[number]["icon"] | typeof MessageSquareTextIcon;
  readonly searchTerms: ReadonlyArray<string>;
  readonly prompt: string;
  /** The prompt on one line, short enough for a tooltip or a palette row. */
  readonly preview: string;
}

// A saved request can run to thousands of characters, which no tooltip should show whole.
const PREVIEW_LENGTH = 240;
const promptPreview = (prompt: string) => truncate(prompt.replace(/\s+/g, " "), PREVIEW_LENGTH);

/**
 * The built-in requests that fit the thread, then the ones the user saved in settings.
 * `hasChanges` is false when git shows nothing to commit, push or review, and null when unknown.
 */
export function availableAgentActions(
  isGitRepo: boolean,
  custom: ReadonlyArray<CustomAgentAction>,
  hasChanges: boolean | null = null,
): ReadonlyArray<AgentAction> {
  return [
    ...AGENT_ACTIONS.filter(
      (action) => (isGitRepo || !action.needsGit) && (hasChanges !== false || !action.needsChanges),
    ).map((action) => ({
      ...action,
      label: t(action.label),
      preview: action.prompt,
    })),
    ...custom.map((action) => ({
      id: `custom:${action.id}`,
      label: action.label,
      icon: MessageSquareTextIcon,
      searchTerms: [action.label],
      prompt: action.prompt,
      preview: promptPreview(action.prompt),
    })),
  ];
}

/** The thread whose chat view can send an agent action now, for the command palette. */
export interface AgentActionsTarget {
  readonly threadKey: string;
  readonly isGitRepo: boolean;
  /** Why the agent cannot take a message now, or null when it can. */
  readonly unavailableReason: string | null;
  readonly ask: (prompt: string) => void;
}

const useAgentActionsTargetStore = create<{ readonly target: AgentActionsTarget | null }>(() => ({
  target: null,
}));

export function useAgentActionsTarget(): AgentActionsTarget | null {
  return useAgentActionsTargetStore((state) => state.target);
}

/** Offers a chat view's agent actions until the returned cleanup runs. */
export function publishAgentActionsTarget(target: AgentActionsTarget): () => void {
  useAgentActionsTargetStore.setState({ target });
  return () => {
    if (useAgentActionsTargetStore.getState().target === target) {
      useAgentActionsTargetStore.setState({ target: null });
    }
  };
}
