import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  notificationAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Error: "error" },
  notificationAsync: mocks.notificationAsync,
}));

vi.mock("./vcs", () => ({ vcsActionManager: {} }));

import { appAtomRegistry } from "./atom-registry";
import {
  dismissGitActionResult,
  gitActionResultAtomFor,
  showGitActionResult,
} from "./use-vcs-action-state";

const threadA = { environmentId: EnvironmentId.make("environment"), cwd: "/repo" };
const threadB = { environmentId: EnvironmentId.make("environment"), cwd: "/repo-worktree" };

afterEach(() => {
  dismissGitActionResult(threadA);
  dismissGitActionResult(threadB);
  vi.useRealTimers();
});

describe("showGitActionResult", () => {
  it("buzzes once per reported result with the matching feedback type", () => {
    showGitActionResult(threadA, { type: "success", title: "Pushed" });
    showGitActionResult(threadA, {
      type: "error",
      title: "Git action failed",
      description: "rejected",
    });

    expect(mocks.notificationAsync.mock.calls).toEqual([["success"], ["error"]]);
  });

  it("keeps a result on the checkout it ran in", () => {
    showGitActionResult(threadA, { type: "success", title: "Pushed" });

    expect(appAtomRegistry.get(gitActionResultAtomFor(threadA))?.title).toBe("Pushed");
    expect(appAtomRegistry.get(gitActionResultAtomFor(threadB))).toBeNull();
  });

  it("dismisses successes on its own and keeps failures until dismissed", () => {
    vi.useFakeTimers();
    showGitActionResult(threadA, { type: "success", title: "Pushed" });
    showGitActionResult(threadB, { type: "error", title: "Git action failed" });

    vi.advanceTimersByTime(5_000);

    expect(appAtomRegistry.get(gitActionResultAtomFor(threadA))).toBeNull();
    expect(appAtomRegistry.get(gitActionResultAtomFor(threadB))?.title).toBe("Git action failed");
    dismissGitActionResult(threadB);
    expect(appAtomRegistry.get(gitActionResultAtomFor(threadB))).toBeNull();
  });

  it("does not let an earlier success's timer clear a later failure", () => {
    vi.useFakeTimers();
    showGitActionResult(threadA, { type: "success", title: "Pushed" });
    showGitActionResult(threadA, { type: "error", title: "Git action failed" });

    vi.advanceTimersByTime(5_000);

    expect(appAtomRegistry.get(gitActionResultAtomFor(threadA))?.title).toBe("Git action failed");
  });
});
