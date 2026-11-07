import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NetworkRecoveryWorker from "./NetworkRecoveryWorker.ts";
import {
  MAX_NETWORK_FAILURE_AGE_MS,
  networkRecoveryPlan,
  probeTargets,
} from "./NetworkRecoveryWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const nowMs = Date.parse("2026-11-06T16:40:00.000Z");
const threadId = ThreadId.make("thread:offline");

const failedRun = (input: {
  readonly id: string;
  readonly userMessageId: string;
  readonly ranMs: number;
  readonly failedAgoMs: number;
}): OrchestrationV2Run => {
  const completedAt = nowMs - input.failedAgoMs;
  return {
    id: RunId.make(input.id),
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    providerThreadId: null,
    userMessageId: MessageId.make(input.userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status: "failed",
    requestedAt: DateTime.makeUnsafe(completedAt - input.ranMs),
    startedAt: DateTime.makeUnsafe(completedAt - input.ranMs),
    completedAt: DateTime.makeUnsafe(completedAt),
    checkpointId: null,
    contextHandoffId: null,
  };
};

const plan = (run: OrchestrationV2Run) =>
  networkRecoveryPlan({ threadId, run, setupFailed: false }, nowMs);

describe("networkRecoveryPlan", () => {
  it("resumes a first network failure as soon as the network is back", () => {
    const run = failedRun({
      id: "run:a",
      userMessageId: "m:user",
      ranMs: 30 * 60_000,
      failedAgoMs: 1_000,
    });
    const resume = plan(run);
    assert.equal(resume?.dueAtMs, nowMs - 1_000);
    const command = resume?.command;
    if (command?.type !== "message.dispatch") return assert.fail("expected a resume");
    assert.equal(command.commandId, "network-resume:1:run:a");
    assert.equal(command.manualContinuationOfRunId, run.id);
    assert.equal(command.creationSource, "server");
  });

  it.each([
    {
      name: "a quick repeat backs off a minute",
      from: 1,
      ranMs: 10_000,
      attempt: 2,
      delay: 60_000,
    },
    {
      name: "a second quick repeat backs off five",
      from: 2,
      ranMs: 10_000,
      attempt: 3,
      delay: 300_000,
    },
    {
      name: "a resume that worked a while counts afresh",
      from: 3,
      ranMs: 600_000,
      attempt: 1,
      delay: 0,
    },
  ])("$name", ({ from, ranMs, attempt, delay }) => {
    const resume = plan(
      failedRun({
        id: "run:b",
        userMessageId: `network-resume:${from}:run:a`,
        ranMs,
        failedAgoMs: 0,
      }),
    );
    assert.equal(resume?.command.commandId, `network-resume:${attempt}:run:b`);
    assert.equal(resume?.dueAtMs, nowMs + delay);
  });

  it("leaves a thread failed after three quick repeats or a day", () => {
    assert.isNull(
      plan(
        failedRun({
          id: "run:c",
          userMessageId: "network-resume:3:run:b",
          ranMs: 10_000,
          failedAgoMs: 0,
        }),
      ),
    );
    assert.isNull(
      plan(
        failedRun({
          id: "run:d",
          userMessageId: "m:user",
          ranMs: 10_000,
          failedAgoMs: MAX_NETWORK_FAILURE_AGE_MS + 1,
        }),
      ),
    );
  });
});

describe("networkRecoveryPlan for a failed workspace setup", () => {
  const setupRun = failedRun({ id: "run:s", userMessageId: "m:user", ranMs: 0, failedAgoMs: 0 });

  it.each([
    { retries: 0, delay: 0 },
    { retries: 1, delay: 60_000 },
    { retries: 2, delay: 300_000 },
  ])("retries the setup after $retries earlier retries in $delay ms", ({ retries, delay }) => {
    const retry = networkRecoveryPlan(
      { threadId, run: setupRun, setupFailed: true },
      nowMs,
      retries,
    );
    assert.deepEqual(retry, {
      dueAtMs: nowMs + delay,
      command: {
        type: "prepared-run.retry",
        commandId: CommandId.make(`network-retry-setup:${retries + 1}:run:s`),
        threadId,
        runId: setupRun.id,
      },
    });
  });

  it("leaves the setup failed after three retries", () => {
    assert.isNull(networkRecoveryPlan({ threadId, run: setupRun, setupFailed: true }, nowMs, 3));
  });
});

describe("probeTargets", () => {
  it("probes the HTTPS proxy when one is set, and the providers otherwise", () => {
    assert.deepEqual(probeTargets({ HTTPS_PROXY: "http://proxy.corp:3128" }), [
      { host: "proxy.corp", port: 3128 },
    ]);
    assert.deepEqual(probeTargets({ HTTPS_PROXY: "not a url" }), [
      { host: "api.anthropic.com", port: 443 },
      { host: "chatgpt.com", port: 443 },
    ]);
  });
});

it.effect("waits offline, then resumes once the network answers", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const online = yield* Ref.make(false);
    const probes = yield* Queue.unbounded<boolean>();
    const dispatched = yield* Queue.unbounded<OrchestrationV2Command>();
    const run = failedRun({
      id: "run:a",
      userMessageId: "m:user",
      ranMs: 60_000,
      failedAgoMs: 1_000,
    });
    const layer = NetworkRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.succeed(
            NetworkRecoveryWorker.NetworkProbe,
            Ref.get(online).pipe(Effect.tap((answer) => Queue.offer(probes, answer))),
          ),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getNetworkRecoveryCandidates: () =>
              Queue.size(dispatched).pipe(
                Effect.map((count) => (count === 0 ? [{ threadId, run, setupFailed: false }] : [])),
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command: OrchestrationV2Command) =>
              Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
          } as never),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({ retryThreadsAfterNetworkErrors: true } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.isFalse(yield* Queue.take(probes));
      assert.equal(yield* Queue.size(dispatched), 0);
      yield* Ref.set(online, true);
      // Offline, the next check is 30 seconds out.
      yield* TestClock.adjust("30 seconds");
      assert.isTrue(yield* Queue.take(probes));
      assert.equal((yield* Queue.take(dispatched)).commandId, "network-resume:1:run:a");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retries a failed setup again a minute after it fails again", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const retried = yield* Queue.unbounded<string>();
    // The setup keeps failing: every read finds the run failed when the test began.
    const candidate = {
      threadId,
      setupFailed: true,
      run: failedRun({ id: "run:s", userMessageId: "m:user", ranMs: 0, failedAgoMs: 0 }),
    };
    const layer = NetworkRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.succeed(NetworkRecoveryWorker.NetworkProbe, Effect.succeed(true)),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getNetworkRecoveryCandidates: () => Effect.succeed([candidate]),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            retryPreparation: (input) =>
              Queue.offer(retried, input.commandId).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({ retryThreadsAfterNetworkErrors: true } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(retried), "network-retry-setup:1:run:s");
      yield* TestClock.adjust("59 seconds");
      assert.equal(yield* Queue.size(retried), 0);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Queue.take(retried), "network-retry-setup:2:run:s");
    }).pipe(Effect.provide(layer));
  }),
);
