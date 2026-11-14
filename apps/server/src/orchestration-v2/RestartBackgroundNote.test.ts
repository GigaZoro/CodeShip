import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork as Work,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  backgroundWorkStoppedNoticeId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  conversationProviderThreadIds,
  isAwaitedWork,
  isRestartNoteContinuation,
  lostBackgroundWorkRecord,
  pendingRestartCancelledBackgroundWork,
  promptBackgroundWorkNote,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
  restartDelegatedTasksNote,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";

const claudeThread = ProviderThreadId.make("provider-thread:claude");
const codexThread = ProviderThreadId.make("provider-thread:codex");
const lost = [{ kind: "subagent" as const, label: "Background subagent test" }];

function run(
  ordinal: number,
  providerThreadId: ProviderThreadId,
  extra: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    providerThreadId,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status: "completed",
    ...extra,
  } as OrchestrationV2Run;
}

const turnFor = (source: OrchestrationV2Run) => ({
  runAttemptId: source.activeAttemptId,
  providerThreadId: source.providerThreadId!,
  status: "completed" as const,
});

const attemptFor = (source: OrchestrationV2Run) => ({
  id: source.activeAttemptId!,
  runId: source.id,
});

/** The owed work as one list, as a prompt's note names it. */
const pendingWork = (input: Parameters<typeof pendingRestartCancelledBackgroundWork>[0]) =>
  pendingRestartCancelledBackgroundWork(input).flatMap((source) => source.work);

it("keeps the note for the provider thread that lost the work across a provider switch", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const onCodex = run(2, codexThread);
  const backOnClaude = run(3, claudeThread);
  const pending = (target: OrchestrationV2Run, runs: ReadonlyArray<OrchestrationV2Run>) =>
    pendingWork({
      runs,
      providerTurns: runs.filter((source) => source.id !== target.id).map(turnFor),
      compactionMessageIds: new Set(),
      run: target,
      attempts: runs.map(attemptFor),
    });

  assert.deepEqual(pending(onCodex, [root, onCodex]), []);
  assert.deepEqual(pending(backOnClaude, [root, onCodex, backOnClaude]), lost);
  const later = run(4, claudeThread);
  assert.deepEqual(pending(later, [root, onCodex, backOnClaude, later]), []);
});

it("owes lost work until a prompt that carried it completes a turn", () => {
  const build: Work = { kind: "shell", label: "vp run build", id: "build" };
  const tests: Work = { kind: "shell", label: "vp test", id: "tests" };
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: [build] });
  // Its session was still closing when this turn built its prompt, so the record came later.
  const startedMeanwhile = run(2, claudeThread);
  const next = run(3, claudeThread);
  const later = run(4, claudeThread);
  const carried = [{ runId: root.id, work: ["id:build"] }];
  const pending = (input: {
    readonly target: OrchestrationV2Run;
    readonly lost?: ReadonlyArray<Work>;
    readonly nextTurn?: "completed" | "interrupted";
  }) =>
    pendingRestartCancelledBackgroundWork({
      runs: [
        { ...root, restartCancelledBackgroundWork: input.lost ?? [build] },
        startedMeanwhile,
        next,
        later,
      ],
      providerTurns: [
        turnFor(root),
        turnFor(startedMeanwhile),
        ...(input.nextTurn === undefined ? [] : [{ ...turnFor(next), status: input.nextTurn }]),
      ],
      compactionMessageIds: new Set(),
      run: input.target,
      attempts: [
        attemptFor(root),
        { ...attemptFor(startedMeanwhile), backgroundWorkNote: [] },
        { ...attemptFor(next), backgroundWorkNote: carried },
      ],
    });

  assert.deepEqual(pending({ target: next }), [{ runId: root.id, work: [build] }]);
  // A prompt the agent may not have read does not settle it either.
  assert.deepEqual(pending({ target: later, nextTurn: "interrupted" }), [
    { runId: root.id, work: [build] },
  ]);
  assert.deepEqual(pending({ target: later, nextTurn: "completed" }), []);
  // A run started again owes what was recorded on it, until a prompt that named it completes.
  const steered = { ...startedMeanwhile, restartCancelledBackgroundWork: [tests] };
  assert.deepEqual(
    pendingRestartCancelledBackgroundWork({
      runs: [root, steered],
      providerTurns: [turnFor(root)],
      compactionMessageIds: new Set(),
      run: steered,
      attempts: [attemptFor(root), { ...attemptFor(steered), backgroundWorkNote: [] }],
    }),
    [
      { runId: root.id, work: [build] },
      { runId: steered.id, work: [tests] },
    ],
  );
  // Work a retried release recorded on the same run later is owed by itself.
  assert.deepEqual(pending({ target: later, nextTurn: "completed", lost: [build, tests] }), [
    { runId: root.id, work: [tests] },
  ]);

  // A wake's text lists what was known when it was queued; its note adds the rest.
  const owed = [{ runId: root.id, work: [build, tests] }];
  assert.deepEqual(promptBackgroundWorkNote(owed, restartCancelledBackgroundWorkNote([build])), {
    text: restartCancelledBackgroundWorkNote([tests]),
    told: [{ runId: root.id, work: ["id:build", "id:tests"] }],
  });
  assert.deepEqual(promptBackgroundWorkNote(owed, "- shell: vp run build --watch").told, [
    { runId: root.id, work: ["id:build", "id:tests"] },
  ]);
  // One line of the wake stands for one entry, also when a later one reads the same.
  const rerun: Work = { ...build, id: "build-2" };
  assert.deepEqual(
    promptBackgroundWorkNote(
      [{ runId: root.id, work: [build, rerun] }],
      restartCancelledBackgroundWorkNote([build]),
    ),
    {
      text: restartCancelledBackgroundWorkNote([rerun]),
      told: [{ runId: root.id, work: ["id:build", "id:build-2"] }],
    },
  );
  // What the note does not name is not told: it stays owed for the next prompt.
  const many = Array.from({ length: 12 }, (_, index): Work => {
    return { kind: "task", label: `task ${index}`, id: `task-${index}` };
  });
  const capped = promptBackgroundWorkNote([{ runId: root.id, work: many }]);
  assert.isTrue(capped.text.endsWith("- task: task 9\n- and 2 more"));
  assert.deepEqual(
    capped.told[0]?.work,
    many.slice(0, 10).map((entry) => `id:${entry.id}`),
  );
});

it("delivers the note to the account that resumes the same native conversation", () => {
  const otherAccountThread = ProviderThreadId.make("provider-thread:claude-other-account");
  const row = (id: ProviderThreadId, nativeId: string, driver = "claudeAgent") =>
    ({ id, driver, nativeThreadRef: { nativeId } }) as Parameters<
      typeof conversationProviderThreadIds
    >[0];
  const conversation = conversationProviderThreadIds(row(otherAccountThread, "native-1"), [
    row(claudeThread, "native-1"),
    row(otherAccountThread, "native-1"),
    row(codexThread, "native-1", "codex"),
    row(ProviderThreadId.make("provider-thread:claude-fork"), "native-2"),
  ]);
  assert.deepEqual([...conversation].sort(), [claudeThread, otherAccountThread].sort());

  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const moved = run(2, otherAccountThread);
  const later = run(3, otherAccountThread);
  const pending = (target: OrchestrationV2Run, runs: ReadonlyArray<OrchestrationV2Run>) =>
    pendingWork({
      runs,
      providerTurns: runs.filter((source) => source.id !== target.id).map(turnFor),
      compactionMessageIds: new Set(),
      run: target,
      attempts: runs.map(attemptFor),
      conversation,
    });
  assert.deepEqual(pending(moved, [root, moved]), lost);
  assert.deepEqual(pending(later, [root, moved, later]), []);
});

it("delivers a resumed queued run's note even after a higher-ordinal run", () => {
  const ranFirst = run(3, claudeThread, {
    completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
  });
  const resumed = run(2, claudeThread, {
    completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    restartCancelledBackgroundWork: lost,
  });
  const next = run(4, claudeThread);
  const runs = [resumed, ranFirst, next];
  assert.deepEqual(
    pendingWork({
      runs,
      providerTurns: [resumed, ranFirst].map(turnFor),
      compactionMessageIds: new Set(),
      run: next,
      attempts: runs.map(attemptFor),
    }),
    lost,
  );
});

// regression: #19750 wake threads whose subagents' background work a restart cut
it("names a lost subagent by the id the agent resumes it with", () => {
  const ownShell = cancelledRosterTaskWork({
    kind: "command",
    taskId: "shell-1",
    description: "sleep 150",
    parentTaskId: "agent-1",
  });
  assert.deepEqual(ownShell, {
    kind: "subagent",
    label: "sleep 150 (subagent agent-1)",
    id: "agent-1",
  });
  assert.isTrue(isAwaitedWork(ownShell));
  const long = cancelledRosterTaskWork({
    kind: "command",
    taskId: "shell-1",
    description: "d".repeat(400),
    parentTaskId: "agent-1",
  }).label;
  assert.lengthOf(long, 160);
  assert.isTrue(long.endsWith("(subagent agent-1)"));
  const longId = cancelledRosterTaskWork({
    kind: "command",
    taskId: "shell-1",
    parentTaskId: "a".repeat(400),
  }).label;
  assert.lengthOf(longId, 160);
  assert.isFalse(isAwaitedWork(cancelledRosterTaskWork({ kind: "command", taskId: "shell-2" })));
  assert.isFalse(isAwaitedWork(cancelledRosterTaskWork({ kind: "monitor", taskId: "watchdog" })));
  assert.isTrue(
    isAwaitedWork(cancelledRosterTaskWork({ kind: "background_task", taskId: "tests" })),
  );
  assert.equal(
    cancelledTurnItemWork({
      id: "item-1",
      type: "subagent",
      origin: "provider_native",
      title: "Review",
      nativeItemRef: { driver: "claudeAgent", nativeId: "agent-1", strength: "strong" },
    } as never)?.label,
    "Review (id agent-1)",
  );
});

it("keeps separate cancelled tasks that share a kind and label", () => {
  const first = { kind: "shell" as const, label: "sleep 20", id: "item-1" };
  const second = { kind: "shell" as const, label: "sleep 20", id: "item-2" };
  const merged = mergeRestartCancelledBackgroundWork([first], [second, first]);
  assert.deepEqual(merged, [first, second]);
  const legacy = { kind: "shell" as const, label: "sleep 20" };
  assert.lengthOf(mergeRestartCancelledBackgroundWork([legacy], [legacy]), 1);
});

it("lists the unfinished delegated task a restart cut, however many finished before it", () => {
  const task = (index: number, status: "completed" | "running") => ({
    id: NodeId.make(`node:delegated-task:${index}`),
    childThreadId: ThreadId.make(`thread:delegated-task:${index}`),
    title: `Task ${index}`,
    prompt: `Task ${index}`,
    status,
  });
  const finished = Array.from({ length: 10 }, (_, index) => task(index, "completed"));
  const note = restartDelegatedTasksNote([...finished, task(10, "running")])!.split("\n");

  assert.equal(
    note[1],
    "- Task 10: taskId node:delegated-task:10, childThreadId thread:delegated-task:10, running",
  );
  assert.equal(
    note[2],
    "- Task 9: taskId node:delegated-task:9, childThreadId thread:delegated-task:9, completed",
  );
  assert.equal(note.at(-1), "- and 1 more");
});

it("tells the agent a command it started still runs and will wake it", () => {
  const note = restartDelegatedTasksNote([
    {
      id: NodeId.make("node:delegated-task:command"),
      childThreadId: null,
      title: "Checks",
      prompt: "vp run check:changed",
      status: "running",
      command: {
        command: "vp run check:changed",
        cwd: "/work",
        logPath: "/state/logs/commands/a/output.log",
        timeoutMinutes: 60,
      },
    },
  ])!.split("\n");

  assert.match(
    note[0]!,
    /t3_command_run\. The restart did not stop them, and each one's end wakes you/,
  );
  assert.equal(note[1], "- Checks: taskId node:delegated-task:command, running");
});

it("gives each loss on a run its own notice, listing only the work it adds", () => {
  const now = DateTime.makeUnsafe("2026-11-12T10:00:00.000Z");
  const shell = { kind: "shell" as const, label: "sleep 20", id: "task-1" };
  const monitor = { kind: "monitor" as const, label: "tail -f log", id: "task-2" };
  const record = (
    current: OrchestrationV2Run,
    work: ReadonlyArray<typeof shell | typeof monitor>,
  ) => lostBackgroundWorkRecord({ run: current, cause: "process-ended", work, now });

  const first = record(run(1, claudeThread), [shell]);
  const lostOnce = run(1, claudeThread, {
    restartCancelledBackgroundWork: first.restartCancelledBackgroundWork,
  });
  const repeated = record(lostOnce, [shell]);
  const second = record(lostOnce, [shell, monitor]);

  assert.equal(first.notice?.id, backgroundWorkStoppedNoticeId(lostOnce.id));
  assert.isUndefined(repeated.notice, "work the run already holds adds no notice");
  assert.notEqual(second.notice?.id, first.notice?.id);
  assert.deepEqual(second.restartCancelledBackgroundWork, [shell, monitor]);
  assert.notInclude(second.notice?.message ?? "", "sleep 20");
});

it("does not repeat the note when a steer restarts the run on a new attempt", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const steered = run(2, claudeThread, {
    activeAttemptId: RunAttemptId.make("attempt:2b"),
  });
  const firstAttempt = RunAttemptId.make("attempt:2a");
  const pending = (runAttemptIds: ReadonlyArray<RunAttemptId>, delivered: boolean) =>
    pendingWork({
      runs: [root, steered],
      providerTurns: [
        turnFor(root),
        ...(delivered
          ? [
              {
                runAttemptId: firstAttempt,
                providerThreadId: claudeThread,
                status: "completed" as const,
              },
            ]
          : []),
      ],
      compactionMessageIds: new Set(),
      run: steered,
      attempts: runAttemptIds.map((id) => ({ id, runId: steered.id })),
    });

  assert.deepEqual(pending([firstAttempt, RunAttemptId.make("attempt:2b")], true), []);
  assert.deepEqual(pending([firstAttempt, RunAttemptId.make("attempt:2b")], false), lost);
});

it("counts a prompted mid-turn or chained continuation as delivering the note", () => {
  const cut = run(1, claudeThread, { status: "cancelled", restartCancelledBackgroundWork: lost });
  const cutTurn = { ...turnFor(cut), status: "cancelled" as const };
  const continuation = run(2, claudeThread, { restartContinuationOfRunId: cut.id });
  assert.isTrue(isRestartNoteContinuation(continuation, [cut, continuation], [cutTurn], []));
  assert.isFalse(
    isRestartNoteContinuation(
      continuation,
      [{ ...cut, restartCancelledBackgroundWork: [] }, continuation],
      [cutTurn],
      [],
    ),
  );
  const later = run(3, claudeThread);
  const pending = (delivered: boolean) =>
    pendingWork({
      runs: [cut, continuation, later],
      providerTurns: [cutTurn, ...(delivered ? [turnFor(continuation)] : [])],
      compactionMessageIds: new Set(),
      run: later,
      attempts: [cut, continuation, later].map(attemptFor),
    });
  assert.deepEqual(pending(true), []);
  assert.deepEqual(pending(false), lost);

  const unstarted = { ...continuation, status: "cancelled" as const };
  const chained = run(3, claudeThread, { restartContinuationOfRunId: unstarted.id });
  assert.deepEqual(restartContinuationNote(unstarted, [cut, unstarted], [cutTurn], []), {
    work: lost,
    settled: false,
    runIds: [unstarted.id, cut.id],
  });
  assert.isTrue(isRestartNoteContinuation(chained, [cut, unstarted, chained], [cutTurn], []));
  for (const status of ["running", "cancelled"] as const) {
    const turns = [cutTurn, { ...turnFor(unstarted), status }];
    assert.deepEqual(restartContinuationNote(unstarted, [cut, unstarted], turns, []), {
      work: lost,
      settled: false,
      runIds: [unstarted.id, cut.id],
    });
    assert.deepEqual(
      pendingWork({
        runs: [cut, unstarted, later],
        providerTurns: turns,
        compactionMessageIds: new Set(),
        run: later,
        attempts: [cut, unstarted, later].map(attemptFor),
      }),
      lost,
    );
  }

  const steered = { ...unstarted, activeAttemptId: RunAttemptId.make("attempt:replacement") };
  const attempts = [{ id: unstarted.activeAttemptId!, runId: steered.id }];
  const turns = [
    cutTurn,
    turnFor(unstarted),
    { ...turnFor(steered), status: "cancelled" as const },
  ];
  assert.deepEqual(restartContinuationNote(steered, [cut, steered], turns, attempts).work, []);
  assert.isFalse(isRestartNoteContinuation(chained, [cut, steered, chained], turns, attempts));
  assert.deepEqual(
    pendingWork({
      runs: [cut, steered, later],
      providerTurns: turns,
      compactionMessageIds: new Set(),
      run: later,
      attempts,
    }),
    [],
  );
});
