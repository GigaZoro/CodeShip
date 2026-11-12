import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure, ScheduledTaskId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as SharedTaskPeerCheck from "./SharedTaskPeerCheck.ts";

const TASK = ScheduledTaskId.make("scheduled-task:shared");
const PEER = EnvironmentId.make("environment-peer");
const SINCE = "2026-09-09T11:30:00.000Z";

type PeerAnswer = (call: {
  readonly environmentId: EnvironmentId;
}) => Effect.Effect<unknown, OrchestratorMcpFailure>;

const check = (input: {
  readonly linked?: "reachable" | "expired" | "none";
  readonly enabled?: boolean;
  readonly peers?: ReadonlyArray<EnvironmentId>;
  readonly answer: PeerAnswer;
}) =>
  Effect.gen(function* () {
    const service = yield* SharedTaskPeerCheck.SharedTaskPeerCheck;
    return yield* service.check({ taskId: TASK, peers: input.peers ?? [PEER], since: SINCE });
  }).pipe(
    Effect.provide(
      SharedTaskPeerCheck.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(PeerLinks.PeerLinks)({
              enabled: Effect.succeed(input.enabled ?? true),
              get: () =>
                Effect.succeed(
                  input.linked === "none"
                    ? Option.none()
                    : Option.some({
                        environmentId: PEER,
                        expiresAt: DateTime.makeUnsafe(
                          input.linked === "expired" ? 0 : "2100-01-01T00:00:00Z",
                        ),
                      } as never),
                ),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({ call: input.answer as never }),
          ),
        ),
      ),
    ),
  );

const peerTask =
  (lastRun: unknown, fields: Record<string, unknown> = {}) =>
  () =>
    Effect.succeed({ tasks: [{ scheduledTaskId: TASK, lastRun, ...fields }] });

const EARLIER_RUN = { at: "2026-09-09T10:00:00.000Z", outcome: "completed" };

it.effect.each([
  {
    name: "working in the window",
    lastRun: { at: "2026-09-09T12:00:00.000Z", outcome: "working" },
    ranOn: PEER,
    working: true,
  },
  {
    name: "completed in the window",
    lastRun: { at: "2026-09-09T11:30:00.000Z", outcome: "completed" },
    ranOn: PEER,
    working: false,
  },
  {
    name: "completed before the window",
    lastRun: { at: "2026-09-09T11:29:59.999Z", outcome: "completed" },
    ranOn: null,
    working: false,
  },
  {
    name: "failed in the window",
    lastRun: { at: "2026-09-09T12:00:00.000Z", outcome: "failed" },
    ranOn: null,
    working: false,
  },
  {
    name: "stopped on purpose in the window",
    lastRun: { at: "2026-09-09T12:00:00.000Z", outcome: "failed", stopped: true },
    ranOn: PEER,
    working: false,
  },
  {
    name: "skipped for no work in the window",
    lastRun: EARLIER_RUN,
    fields: {
      lastSkipped: { at: SINCE, scheduledFor: SINCE, reason: "No open pull requests" },
    },
    ranOn: PEER,
    working: false,
    noWork: { reason: "No open pull requests" },
  },
  {
    name: "skipped for no work before the window",
    lastRun: EARLIER_RUN,
    fields: {
      lastSkipped: {
        at: "2026-09-09T11:29:59.999Z",
        scheduledFor: null,
        reason: "No open pull requests",
      },
    },
    ranOn: null,
    working: false,
  },
  {
    name: "checking whether there is work",
    lastRun: EARLIER_RUN,
    fields: { checkingSince: "2026-09-09T12:00:00.000Z" },
    ranOn: PEER,
    working: true,
  },
  { name: "never run", lastRun: null, ranOn: null, working: false },
])("a peer's last run $name", ({ lastRun, fields, ranOn, working, noWork }) =>
  check({ answer: peerTask(lastRun, fields) }).pipe(
    Effect.map((result) => {
      expect(result.ranOn).toBe(ranOn);
      expect(result.working).toBe(working);
      expect(result.noWork).toEqual(noWork ?? null);
      expect(result.unchecked).toEqual([]);
    }),
  ),
);

it.effect.each([
  { name: "ran it", fields: {}, noWork: null },
  {
    name: "skipped it for no work",
    fields: { lastSkipped: { at: SINCE, scheduledFor: SINCE, reason: null } },
    noWork: { reason: null },
  },
])("a peer that $name wins over one still working", ({ fields, noWork }) =>
  check({
    peers: [EnvironmentId.make("environment-working"), PEER],
    answer: ({ environmentId }) =>
      environmentId === PEER
        ? peerTask(
            noWork === null
              ? { at: "2026-09-09T12:00:00.000Z", outcome: "completed" }
              : EARLIER_RUN,
            fields,
          )()
        : peerTask({ at: "2026-09-09T12:00:00.000Z", outcome: "working" })(),
  }).pipe(
    Effect.map((result) => {
      expect(result.ranOn).toBe(PEER);
      expect(result.working).toBe(false);
      expect(result.noWork).toEqual(noWork);
    }),
  ),
);

it.effect.each([
  {
    name: "links are off",
    input: { enabled: false, answer: peerTask(null) },
    reason: "Linked environments is turned off here.",
  },
  {
    name: "there is no link",
    input: { linked: "none" as const, answer: peerTask(null) },
    reason: "This machine is not linked.",
  },
  {
    name: "the link expired",
    input: { linked: "expired" as const, answer: peerTask(null) },
    reason: "The link has expired.",
  },
  {
    name: "the call fails",
    input: {
      answer: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "It stopped answering.",
          }),
        ),
    },
    reason: "It stopped answering.",
  },
  {
    name: "the task is not there",
    input: { answer: () => Effect.succeed({ tasks: [] }) },
    reason: "It does not have this task yet.",
  },
  {
    name: "it predates lastRun",
    input: { answer: () => Effect.succeed({ tasks: [{ scheduledTaskId: TASK }] }) },
    reason: "It runs an older version of T3.CodeShip.",
  },
])("a peer is unchecked when $name", ({ input, reason }) =>
  check(input).pipe(
    Effect.map((result) => {
      expect(result.ranOn).toBeNull();
      expect(result.unchecked).toEqual([{ environmentId: PEER, reason }]);
    }),
  ),
);

it.effect("a peer that does not answer within 20 seconds is unchecked", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(check({ answer: () => Effect.never }));
    yield* TestClock.adjust("20 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result.unchecked).toEqual([
      { environmentId: PEER, reason: "It did not answer in time." },
    ]);
  }),
);
