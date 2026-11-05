import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpSharedScheduledTasksResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as SharedTaskPull from "./SharedTaskPull.ts";
import { HERE_ENVIRONMENT_ID, layerSharedTaskIdentities } from "./sharedTaskTestLayers.ts";

const GOOD = EnvironmentId.make("environment-good");
const DOWN = EnvironmentId.make("environment-down");
const OLD = EnvironmentId.make("environment-expired");

const link = (environmentId: EnvironmentId, expiresAt: string) =>
  ({ environmentId, expiresAt: DateTime.makeUnsafe(expiresAt) }) as never;

const sharedTask = (title: string, at: string) =>
  ({
    id: "scheduled-task:pulled",
    title,
    prompt: "Review the open pull requests.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    followsDefaultModel: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-09-01T00:00:00.000Z",
    shared: {
      revision: { at, environmentId: GOOD },
      project: { type: "none" },
      excludedEnvironmentIds: [],
    },
  }) as never;

const answer = (title: string, at: string): OrchestratorMcpSharedScheduledTasksResult => ({
  tasks: [sharedTask(title, at)],
  deletions: [],
  projectMachineOrders: [],
});

const pull = (input: {
  readonly enabled?: boolean;
  readonly answers: Record<string, OrchestratorMcpSharedScheduledTasksResult | "fail">;
  readonly calls: Ref.Ref<ReadonlyArray<{ environmentId: string; arguments: unknown }>>;
  readonly applied: Ref.Ref<ReadonlyArray<string>>;
}) =>
  Effect.gen(function* () {
    const service = yield* SharedTaskPull.SharedTaskPull;
    yield* service.pullOnce;
  }).pipe(
    Effect.provide(
      SharedTaskPull.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerSharedTaskIdentities(),
            Layer.mock(PeerLinks.PeerLinks)({
              enabled: Effect.succeed(input.enabled ?? true),
              listStored: Effect.succeed([
                link(GOOD, "2027-01-01T00:00:00.000Z"),
                link(DOWN, "2027-01-01T00:00:00.000Z"),
                link(OLD, "2020-01-01T00:00:00.000Z"),
              ]),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: ((request: { environmentId: string; arguments: unknown }) =>
                Ref.update(input.calls, (calls) => [...calls, request]).pipe(
                  Effect.andThen(() => {
                    const result = input.answers[request.environmentId];
                    return result === "fail" || result === undefined
                      ? Effect.fail(
                          new OrchestratorMcpFailure({
                            code: "orchestration_error",
                            message: "It stopped answering.",
                          }),
                        )
                      : Effect.succeed(result);
                  }),
                )) as never,
            }),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              applyShared: (request) =>
                Ref.update(input.applied, (applied) => [
                  ...applied,
                  request.type === "upsert" ? request.task.title : request.type,
                ]).pipe(Effect.as({ outcome: "applied" as const })),
            }),
          ),
        ),
      ),
    ),
  );

it.effect("pulls each live link with this machine's id and applies what it returns", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-09T12:00:00.000Z"));
    const calls = yield* Ref.make<ReadonlyArray<{ environmentId: string; arguments: unknown }>>([]);
    const applied = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* pull({
      answers: { [GOOD]: answer("Good", "2026-09-10T00:00:00.000Z"), [DOWN]: "fail" },
      calls,
      applied,
    });
    const made = yield* Ref.get(calls);
    // The expired link is skipped; the failing peer neither blocks nor hides the good one.
    expect(made.map((call) => call.environmentId).toSorted()).toEqual([DOWN, GOOD]);
    expect(made[0]?.arguments).toEqual({ forEnvironmentId: HERE_ENVIRONMENT_ID });
    expect(yield* Ref.get(applied)).toEqual(["Good"]);
  }),
);

it.effect("pulls nothing while linked environments is off", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<{ environmentId: string; arguments: unknown }>>([]);
    const applied = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* pull({ enabled: false, answers: {}, calls, applied });
    expect(yield* Ref.get(calls)).toEqual([]);
  }),
);
