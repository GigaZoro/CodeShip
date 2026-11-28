import type { ToastManager } from "@base-ui/react/toast";
import { describe, expect, it } from "vite-plus/test";

import {
  NOTICE_COALESCE_WINDOW_MS,
  NOTICE_LOG_CAPACITY,
  createNoticeLog,
  summarizeNoticeEmitters,
  withNoticeLog,
  type NoticeData,
} from "./toastNoticeLog";

interface ManagerCall {
  readonly method: "add" | "update" | "close";
  readonly id: string | undefined;
  readonly options: Record<string, unknown> | undefined;
}

function fakeManager(calls: ManagerCall[], onCloses: Map<string, () => void>) {
  return {
    add(options: { id?: string; onClose?: () => void }) {
      const id = options.id ?? "unexpected";
      calls.push({ method: "add", id, options });
      if (options.onClose) onCloses.set(id, options.onClose);
      return id;
    },
    update(id: string, options: { onClose?: () => void }) {
      calls.push({ method: "update", id, options });
      if (options.onClose) onCloses.set(id, options.onClose);
    },
    close(id?: string) {
      calls.push({ method: "close", id, options: undefined });
    },
    promise: () => Promise.resolve(),
    " subscribe": () => () => {},
  } as unknown as ToastManager<NoticeData>;
}

function setup() {
  const clock = { wall: 1_000_000, mono: 0 };
  const log = createNoticeLog({ now: () => clock.wall, monotonicNow: () => clock.mono });
  const calls: ManagerCall[] = [];
  const onCloses = new Map<string, () => void>();
  const manager = withNoticeLog(fakeManager(calls, onCloses), log, "toast");
  const anchored = withNoticeLog(fakeManager(calls, onCloses), log, "anchored");
  const advance = (ms: number) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  /** What base-ui does when a toast times out or is swiped away. */
  const expire = (id: string) => onCloses.get(id)?.();
  return { log, manager, anchored, calls, advance, expire, clock };
}

describe("withNoticeLog", () => {
  it("records source, type, thread and time for each notice", () => {
    const { log, manager } = setup();
    manager.add({
      type: "error",
      title: "Push failed",
      data: { source: "thread-notification", threadRef: { environmentId: "e", threadId: "t" } },
    });
    expect(log.getSnapshot()).toMatchObject([
      {
        source: "thread-notification",
        type: "error",
        threadKey: "e:t",
        firstAt: 1_000_000,
        delivery: "toast",
        outcome: "open",
      },
    ]);
  });

  it("counts an untagged notice as a user action", () => {
    const { log, manager } = setup();
    manager.add({ title: "Copied" });
    expect(log.getSnapshot()[0]?.source).toBe("user-action");
  });

  it("keeps only the last notices once the log is full", () => {
    const { log, manager } = setup();
    for (let index = 0; index < NOTICE_LOG_CAPACITY + 5; index += 1) {
      manager.add({ title: `Notice ${index}`, data: { source: "slow-rpc" } });
    }
    const snapshot = log.getSnapshot();
    expect([snapshot.length, snapshot[0]?.title, snapshot.at(-1)?.title]).toEqual([
      NOTICE_LOG_CAPACITY,
      `Notice ${NOTICE_LOG_CAPACITY + 4}`,
      "Notice 5",
    ]);
  });

  it("re-adds the open toast's id with a count when the same notice repeats within the window, so its timer restarts", () => {
    const { log, manager, calls, advance } = setup();
    const first = manager.add({ title: "Sync failed", data: { source: "permission-update" } });
    advance(NOTICE_COALESCE_WINDOW_MS - 1);
    const second = manager.add({ title: "Sync failed", data: { source: "permission-update" } });
    expect({
      second,
      records: log.getSnapshot().map((record) => record.count),
      lastCall: [
        calls.at(-1)?.method,
        calls.at(-1)?.id,
        (calls.at(-1)?.options?.data as NoticeData | undefined)?.repeatCount,
      ],
    }).toEqual({ second: first, records: [2], lastCall: ["add", first, 2] });
  });

  it("does not count a caller updating its own notice by id as a repeat", () => {
    const { log, manager } = setup();
    manager.add({ id: "clone", title: "Cloning", data: { source: "project-clone" } });
    manager.add({ id: "clone", title: "Cloning 50%", data: { source: "project-clone" } });
    expect(
      log.getSnapshot().map(({ count, title, outcome }) => ({ count, title, outcome })),
    ).toEqual([{ count: 1, title: "Cloning 50%", outcome: "open" }]);
  });

  it("never merges a quiet notice into a toast or a toast into the log", () => {
    const { log, manager } = setup();
    manager.add({ title: "Slow", data: { source: "slow-rpc", quiet: true } });
    manager.add({ title: "Slow", data: { source: "slow-rpc" } });
    expect(log.getSnapshot().map((record) => record.delivery)).toEqual(["toast", "activity-log"]);
  });

  it("closes the visible toast when its id moves to the log", () => {
    const { log, manager, calls } = setup();
    manager.add({ id: "clone", title: "Stalled", data: { source: "project-clone" } });
    manager.add({ id: "clone", title: "Cloning", data: { source: "project-clone", quiet: true } });
    expect({
      calls: calls.map(({ method, id }) => [method, id]),
      record: log.get("clone")?.delivery,
    }).toEqual({
      calls: [
        ["add", "clone"],
        ["close", "clone"],
      ],
      record: "activity-log",
    });
  });

  it("shows a toast when a logged id becomes one", () => {
    const { log, manager, calls } = setup();
    manager.add({ id: "clone", title: "Cloning", data: { source: "project-clone", quiet: true } });
    manager.add({ id: "clone", title: "Stalled", data: { source: "project-clone" } });
    expect({
      calls: calls.map(({ method, id }) => [method, id]),
      record: log.get("clone")?.delivery,
    }).toEqual({ calls: [["add", "clone"]], record: "toast" });
  });

  it("adds a new toast once the window has passed", () => {
    const { log, manager, advance } = setup();
    manager.add({ title: "Sync failed", data: { source: "permission-update" } });
    advance(NOTICE_COALESCE_WINDOW_MS + 1);
    manager.add({ title: "Sync failed", data: { source: "permission-update" } });
    expect(log.getSnapshot().map((record) => record.count)).toEqual([1, 1]);
  });

  it("measures the window on the monotonic clock, not the wall clock", () => {
    const { log, manager, clock } = setup();
    manager.add({ title: "Sync failed", data: { source: "permission-update" } });
    clock.wall += NOTICE_COALESCE_WINDOW_MS * 10;
    manager.add({ title: "Sync failed", data: { source: "permission-update" } });
    expect(log.getSnapshot().map((record) => record.count)).toEqual([2]);
  });

  it("keeps different messages from one source apart", () => {
    const { log, manager } = setup();
    manager.add({ title: "Sync failed", data: { source: "permission-update" } });
    manager.add({ title: "Permissions updated", data: { source: "permission-update" } });
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("keeps the same message on different threads apart", () => {
    const { log, manager } = setup();
    manager.add({ title: "Done", data: { source: "thread-notification", threadId: "a" } });
    manager.add({ title: "Done", data: { source: "thread-notification", threadId: "b" } });
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("sends quiet notices to the activity log instead of the toast stack", () => {
    const { log, manager, calls } = setup();
    const id = manager.add({ title: "Slow request", data: { source: "slow-rpc", quiet: true } });
    manager.update(id, { title: "Slow request (12s)" });
    manager.close(id);
    expect({
      calls,
      record: log
        .getSnapshot()
        .map(({ delivery, title, outcome }) => ({ delivery, title, outcome })),
    }).toEqual({
      calls: [],
      record: [{ delivery: "activity-log", title: "Slow request (12s)", outcome: "closed" }],
    });
  });

  it("records a toast that timed out as auto-dismissed and still runs its own onClose", () => {
    const { log, manager, expire } = setup();
    let closed = 0;
    const id = manager.add({
      title: "Saved",
      data: { source: "keybindings-update" },
      onClose: () => {
        closed += 1;
      },
    });
    expire(id);
    expect([log.get(id)?.outcome, closed]).toEqual(["auto-dismissed", 1]);
  });

  it("records a close the user caused in the same event as dismissed, and a later timeout as auto-dismissed", async () => {
    const { log, manager, expire } = setup();
    const swiped = manager.add({ title: "One", data: { source: "guide-run" } });
    const closedByX = manager.add({ title: "Two", data: { source: "guide-run" } });
    const timedOut = manager.add({ title: "Three", data: { source: "guide-run" } });
    log.markDismissing(swiped);
    expire(swiped);
    log.markDismissing(closedByX);
    manager.close(closedByX);
    log.markDismissing(timedOut);
    await Promise.resolve();
    expire(timedOut);
    expect([swiped, closedByX, timedOut].map((id) => log.get(id)?.outcome)).toEqual([
      "dismissed",
      "dismissed",
      "auto-dismissed",
    ]);
  });

  it("records a toast the user acted on as clicked, however it then closed", () => {
    const { log, manager } = setup();
    const id = manager.add({ title: "Ready", data: { source: "guide-run" } });
    log.markClicked(id);
    manager.close(id);
    expect(log.get(id)?.outcome).toBe("clicked");
  });

  it("records the open toasts of one manager as closed when it closes all, and leaves the other's", () => {
    const { log, manager, anchored } = setup();
    anchored.add({ title: "Copied", data: { source: "guide-run" } });
    manager.add({ title: "One", data: { source: "guide-run" } });
    manager.add({ title: "Two", data: { source: "guide-run" } });
    manager.close();
    expect(log.getSnapshot().map((record) => record.outcome)).toEqual(["closed", "closed", "open"]);
  });

  it("does not coalesce a notice into the other manager's toast", () => {
    const { log, manager, anchored } = setup();
    anchored.add({ title: "Copied", data: { source: "guide-run" } });
    manager.add({ title: "Copied", data: { source: "guide-run" } });
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("evicts ended notices before an ongoing one when the log is full", () => {
    const { log, manager } = setup();
    manager.add({
      id: "ongoing",
      title: "Cloning",
      data: { source: "project-clone", quiet: true },
    });
    for (let index = 0; index < NOTICE_LOG_CAPACITY; index += 1) {
      manager.close(manager.add({ title: `Done ${index}`, data: { source: "slow-rpc" } }));
    }
    expect([log.getSnapshot().length, log.get("ongoing")?.outcome]).toEqual([
      NOTICE_LOG_CAPACITY,
      "open",
    ]);
  });
});

describe("summarizeNoticeEmitters", () => {
  it("ranks sources by notices shown, repeats included, and counts their outcomes", () => {
    const { log, manager, advance } = setup();
    manager.add({ title: "Slow", data: { source: "slow-rpc", quiet: true } });
    manager.add({ title: "Slow", data: { source: "slow-rpc", quiet: true } });
    manager.add({ title: "Slow 2", data: { source: "slow-rpc", quiet: true } });
    advance(1_000);
    const guide = manager.add({ title: "Ready", data: { source: "guide-run" } });
    log.markClicked(guide);
    manager.close(guide);
    expect(summarizeNoticeEmitters(log.getSnapshot())).toEqual([
      {
        source: "slow-rpc",
        shown: 3,
        toasts: 0,
        logged: 3,
        clicked: 0,
        dismissed: 0,
        autoDismissed: 0,
        lastAt: 1_000_000,
        lastTitle: "Slow 2",
      },
      {
        source: "guide-run",
        shown: 1,
        toasts: 1,
        logged: 0,
        clicked: 1,
        dismissed: 0,
        autoDismissed: 0,
        lastAt: 1_001_000,
        lastTitle: "Ready",
      },
    ]);
  });
});
