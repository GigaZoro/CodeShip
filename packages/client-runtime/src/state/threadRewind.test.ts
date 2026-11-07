import {
  CommandId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  deriveAvailableRevertTurnCounts,
  deriveRetryTarget,
  deriveRevertTurnCountByUserMessageId,
  revertRunMarkersFromVisibleTurnItems,
  turnsAfterChangedFiles,
  waitForRevertedMessage,
} from "./threadRewind.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";

const runId = (ordinal: number) => RunId.make(`run-${ordinal}`);

describe("revert targets from visible turn items", () => {
  const base = {
    threadId: v2Projection.thread.id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  };
  const row = (
    item: OrchestrationV2ProjectedTurnItem["item"],
    visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
  ) => ({ item, visibility });
  const user = (
    ordinal: number,
    inputIntent: "turn_start" | "queued_turn" | "steer" = "turn_start",
    status: "completed" | "pending" = "completed",
  ) =>
    row({
      ...base,
      status,
      id: TurnItemId.make(`user-item-${ordinal}-${inputIntent}`),
      runId: runId(ordinal),
      type: "user_message",
      messageId: MessageId.make(`user-${ordinal}-${inputIntent}`),
      inputIntent,
      text: "user",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    } as OrchestrationV2ProjectedTurnItem["item"]);
  const assistant = (ordinal: number) =>
    row({
      ...base,
      id: TurnItemId.make(`assistant-item-${ordinal}`),
      runId: runId(ordinal),
      type: "assistant_message",
      messageId: MessageId.make(`assistant-${ordinal}`),
      text: "assistant",
      streaming: false,
    } as OrchestrationV2ProjectedTurnItem["item"]);
  const notification = (ordinal: number, visibility: "local" | "inherited" = "local") =>
    row(
      {
        ...base,
        id: TurnItemId.make(`wake-${ordinal}`),
        runId: runId(ordinal),
        type: "notification",
        source: { kind: "delegated_task", taskIds: [NodeId.make("task-1")] },
        outcome: "unknown",
        summary: "Delegated task finished",
      } as OrchestrationV2ProjectedTurnItem["item"],
      visibility,
    );
  const checkpoint = (ordinal: number) => ({
    runId: runId(ordinal),
    checkpointTurnCount: ordinal,
    status: "ready" as const,
  });
  const targets = (rows: ReadonlyArray<ReturnType<typeof row>>) =>
    Object.fromEntries(
      deriveRevertTurnCountByUserMessageId({
        runMarkers: revertRunMarkersFromVisibleTurnItems(rows),
        checkpoints: [1, 2, 3, 4].map(checkpoint),
        threadStartCheckpointReady: true,
      }),
    );

  it("keeps a notification-only wake run between turns and skips inherited history", () => {
    expect(
      targets([
        { ...user(9), visibility: "inherited" },
        user(1),
        assistant(1),
        notification(2),
        notification(7, "inherited"),
        user(3),
        assistant(3),
      ]),
    ).toEqual({ "user-1-turn_start": 0, "user-3-turn_start": 2 });
  });

  it("edits turn starts and queued turns, but not steering or a queued turn still pending", () => {
    expect(
      targets([
        user(1),
        user(1, "steer"),
        assistant(1),
        user(2, "queued_turn"),
        assistant(2),
        user(3, "queued_turn", "pending"),
      ]),
    ).toEqual({ "user-1-turn_start": 0, "user-2-queued_turn": 1 });
  });
});

describe("deriveRetryTarget", () => {
  const message = (id: string, role: "user" | "assistant", streaming = false) => ({
    id: MessageId.make(id),
    role,
    streaming,
  });
  const turnCounts = new Map([[MessageId.make("user-2"), 1]]);

  it("targets the newest settled reply and the message it answers", () => {
    expect(
      deriveRetryTarget(
        [
          message("user-1", "user"),
          message("reply-1", "assistant"),
          message("user-2", "user"),
        ].concat([message("reply-2a", "assistant"), message("reply-2b", "assistant")]),
        turnCounts,
      ),
    ).toEqual({
      assistantMessageId: MessageId.make("reply-2b"),
      userMessageId: MessageId.make("user-2"),
      turnCount: 1,
    });
  });

  it("offers no retry while streaming, after a newer message, or when the turn cannot rewind", () => {
    const thread = [message("user-2", "user"), message("reply-2", "assistant")];
    expect(deriveRetryTarget(thread, turnCounts)).not.toBeNull();
    expect(
      deriveRetryTarget(
        [message("user-2", "user"), message("reply-2", "assistant", true)],
        turnCounts,
      ),
    ).toBeNull();
    expect(deriveRetryTarget([...thread, message("user-3", "user")], turnCounts)).toBeNull();
    expect(deriveRetryTarget(thread, new Map())).toBeNull();
    // A steer after the turn start has no rewind target of its own.
    expect(
      deriveRetryTarget(
        [message("user-2", "user"), message("steer-2", "user"), message("reply-2", "assistant")],
        turnCounts,
      ),
    ).toBeNull();
  });

  it("keeps the previous target while it names the same exchange", () => {
    const thread = [message("user-2", "user"), message("reply-2", "assistant")];
    const previous = deriveRetryTarget(thread, turnCounts);
    expect(deriveRetryTarget([...thread], new Map(turnCounts), previous)).toBe(previous);
  });
});

describe("turnsAfterChangedFiles", () => {
  const checkpoint = (appRunOrdinal: number | null, files: number, filesTotal?: number) => ({
    appRunOrdinal,
    files: Array.from({ length: files }, (_, index) => ({
      path: `file-${index}`,
      kind: "modified",
      additions: 1,
      deletions: 0,
    })),
    ...(filesTotal === undefined
      ? {}
      : { filesTotal: { count: filesTotal, additions: 0, deletions: 0 } }),
  });

  it("counts only the turns after the rewind target, including truncated file lists", () => {
    const checkpoints = [
      checkpoint(null, 3),
      checkpoint(1, 2),
      checkpoint(2, 0),
      checkpoint(3, 0, 4),
    ];
    expect(turnsAfterChangedFiles(checkpoints, 0)).toBe(true);
    expect(turnsAfterChangedFiles(checkpoints.slice(0, 3), 1)).toBe(false);
    expect(turnsAfterChangedFiles(checkpoints, 2)).toBe(true);
    expect(turnsAfterChangedFiles(checkpoints, 3)).toBe(false);
  });
});

describe("deriveAvailableRevertTurnCounts", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const otherProviderThreadId = ProviderThreadId.make("other-provider-thread");

  function projection(input: { readonly providerSessionId: ProviderSessionId | null }) {
    const run = (ordinal: number) => ({
      id: runId(ordinal),
      ordinal,
      activeAttemptId: `attempt-${ordinal}`,
    });
    const turn = (ordinal: number, attempt: number, threadId: ProviderThreadId) => ({
      id: `turn-${attempt}-${ordinal}`,
      runAttemptId: `attempt-${attempt}`,
      ordinal,
      providerThreadId: threadId,
    });
    return {
      ...v2Projection,
      thread: { ...v2Projection.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          providerInstanceId: v2Projection.thread.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
        },
      ],
      runs: [run(1), run(2), run(3)],
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, providerTurnId: null })),
      // Run 2's latest turn moved to another provider thread, so its checkpoint cannot restore
      // this conversation.
      providerTurns: [
        turn(1, 1, providerThreadId),
        turn(1, 2, providerThreadId),
        turn(2, 2, otherProviderThreadId),
        turn(1, 3, providerThreadId),
      ],
    } as unknown as OrchestrationV2ThreadProjection;
  }

  it("offers the thread start and runs whose latest turn is on the active provider thread", () => {
    const available = deriveAvailableRevertTurnCounts(
      projection({ providerSessionId: ProviderSessionId.make("session") }),
    );
    expect([...available].toSorted()).toEqual([0, 1, 3]);
  });

  it("offers nothing without a provider session to rewind", () => {
    expect(deriveAvailableRevertTurnCounts(projection({ providerSessionId: null })).size).toBe(0);
    expect(deriveAvailableRevertTurnCounts(null).size).toBe(0);
  });
});

describe("waitForRevertedMessage", () => {
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const projection = {
      ...v2Projection,
      thread: { ...v2Projection.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          providerInstanceId: v2Projection.thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("provider-session"),
          appThreadId: v2Projection.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 4,
          handoffIds: [],
          forkedFrom: null,
          createdAt: v2Now,
          updatedAt: v2Now,
        },
      ],
      runs: [1, 2, 3, 4].map((ordinal) => ({
        id: runId(ordinal),
        threadId: v2Projection.thread.id,
        ordinal,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: v2Now,
        startedAt: v2Now,
        completedAt: v2Now,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: [
        {
          id: messageId,
          threadId: v2Projection.thread.id,
          runId: runId(2),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: v2Now,
          updatedAt: v2Now,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const registry = AtomRegistry.make();
    const state = Atom.make({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) });
    const set = (next: OrchestrationV2ThreadProjection) =>
      registry.set(state, { ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(next) });
    const wait = (turnCount: number, revert: () => Promise<void> = async () => {}) =>
      waitForRevertedMessage({ registry, threadAtom: state, turnCount, requestId, revert });
    return { projection, set, wait };
  }

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { projection, set, wait } = projectionAtom();
    const waiting = wait(1);
    await Promise.resolve();
    set({
      ...projection,
      thread: {
        ...projection.thread,
        rollbackFailure: { requestId, message: "The provider could not roll back." },
      },
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it.each([
    ["same", "streamed"],
    ["replacement", "streamed"],
    ["replacement", "refetched"],
  ] as const)(
    "waits for the retained rollback suffix when the edited message and run are paged out (%s provider, %s)",
    async (providerIdentity, projectionSource) => {
      vi.useFakeTimers();
      const { projection, set, wait } = projectionAtom();
      const latestRunId = RunId.make("latest-run-9");
      const latestRun = {
        ...projection.runs[3]!,
        id: latestRunId,
        ordinal: 9,
        userMessageId: MessageId.make("latest-message-9"),
        status: "cancelled" as const,
      };
      const bounded = {
        ...projection,
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 9,
        })),
        runs: [
          {
            ...latestRun,
            id: RunId.make("old-rewound-run-3"),
            userMessageId: MessageId.make("old-rewound-message-3"),
            ordinal: 3,
            status: "rolled_back" as const,
          },
          latestRun,
        ],
      };
      const oldProviderThread = bounded.providerThreads[0]!;
      const completedProviderThread = {
        ...oldProviderThread,
        ...(providerIdentity === "replacement"
          ? { id: ProviderThreadId.make("replacement-provider-thread"), firstRunOrdinal: null }
          : {}),
        lastRunOrdinal: null,
      };
      set(bounded);
      let outcome = "pending";
      const waiting = wait(0).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        set({
          ...bounded,
          thread: {
            ...bounded.thread,
            activeProviderThreadId:
              projectionSource === "refetched" ? completedProviderThread.id : oldProviderThread.id,
          },
          providerThreads:
            providerIdentity === "replacement"
              ? [oldProviderThread, completedProviderThread]
              : [completedProviderThread],
          runs: bounded.runs.map((run) =>
            run.id === latestRunId ? { ...run, status: "rolled_back" as const } : run,
          ),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("waits for the requested target when another client finishes a shallower rewind", async () => {
    vi.useFakeTimers();
    const { projection, set, wait } = projectionAtom();
    let outcome = "pending";
    const waiting = wait(1).then(
      () => {
        outcome = "reverted";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      // Our command is accepted while the earlier target-3 effect is still running.
      const shallowerRewind = {
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: requestId, rollbackFailure: null },
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 3,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 3 ? { ...run, status: "rolled_back" as const } : run,
        ),
      };
      set(shallowerRewind);
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      set({
        ...shallowerRewind,
        providerThreads: shallowerRewind.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 1,
        })),
        runs: shallowerRewind.runs.map((run) =>
          run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
        ),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("reverted");
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects a stale edit already rewound by another client during attachment preparation", async () => {
    vi.useFakeTimers();
    const { projection, set, wait } = projectionAtom();
    set({
      ...projection,
      thread: { ...projection.thread, rollbackRequestId: CommandId.make("other-client-rewind") },
      messages: [],
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        lastRunOrdinal: 1,
      })),
      runs: projection.runs.map((run) =>
        run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
      ),
    });
    const revert = vi.fn(async () => {});
    let outcome = "pending";
    const waiting = wait(1, revert).then(
      () => {
        outcome = "reverted";
      },
      () => {
        outcome = "rejected";
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("rejected");
      expect(revert).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
