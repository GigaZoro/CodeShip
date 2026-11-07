import { describe, expect, it } from "vite-plus/test";

import {
  threadRowAccessibilityActions,
  threadRowAccessibilityLabel,
  type ThreadRowSpeech,
} from "./thread-row-accessibility";

const ROW: ThreadRowSpeech = {
  title: "Fix login bug",
  status: null,
  lastKnownMachine: null,
  woke: false,
  time: null,
  error: null,
  pinned: false,
  scheduledTask: false,
  queuedMessages: false,
  regeneratingTitle: false,
  searchExcerpt: null,
  project: null,
  environment: null,
  pullRequest: null,
};

describe("thread row accessibility label", () => {
  it.each<[string, Partial<ThreadRowSpeech>, string]>([
    [
      "a waiting status with its duration and where it runs",
      {
        status: { label: "Approval", duration: "12m" },
        project: "CodeShip",
        environment: "Zoro-PC",
        pullRequest: "#12 pull request open",
      },
      "Fix login bug, Approval 12m, CodeShip, Zoro-PC, #12 pull request open",
    ],
    [
      "a failure with its error",
      { status: { label: "Failed", duration: null }, error: "Usage limit reached" },
      "Fix login bug, Failed, Usage limit reached",
    ],
    [
      "an unread finish, pinned with a scheduled task",
      { status: { label: "Done", duration: null }, pinned: true, scheduledTask: true },
      "Fix login bug, Done, pinned, scheduled task",
    ],
    [
      "the time in place of a status",
      { time: "5m", queuedMessages: true },
      "Fix login bug, 5m, messages queued to send",
    ],
    [
      "Woke over the status it replaces",
      { woke: true, status: { label: "Done", duration: null }, time: "" },
      "Fix login bug, Woke",
    ],
    [
      "a frozen status on an unreachable machine",
      { status: { label: "Working", duration: "3m" }, lastKnownMachine: "Offline" },
      "Fix login bug, Offline, last known status: Working",
    ],
    [
      "the message a search matched",
      { time: "2d", searchExcerpt: "You: the login fails" },
      "Fix login bug, 2d, You: the login fails",
    ],
  ])("reads %s", (_name, row, label) => {
    expect(threadRowAccessibilityLabel({ ...ROW, ...row })).toBe(label);
  });
});

describe("thread row accessibility actions", () => {
  const presets = [{ id: "tomorrow", label: "Tomorrow", whenLabel: "9:00 AM" }];

  it("offers the swipe actions, each named as its menu event", () => {
    expect(
      threadRowAccessibilityActions({
        canOperate: true,
        primary: { kind: "settle", label: "Settle" },
        snoozePresets: presets,
        pullRequest: null,
        dismissWoke: false,
      }).map((action) => action.name),
    ).toEqual(["settle", "snooze:tomorrow", "snooze:custom", "delete"]);
  });

  it("leaves a read-only row only what needs no permission", () => {
    expect(
      threadRowAccessibilityActions({
        canOperate: false,
        primary: { kind: "settle", label: "Settle" },
        snoozePresets: presets,
        pullRequest: "Open #12 pull request open",
        dismissWoke: true,
      }).map((action) => action.name),
    ).toEqual(["openPullRequests", "dismissWoke"]);
  });
});
