import { makeAggregateState } from "./agentActivityAggregate.ts";
import type { RelayAgentActivityState, RelayDeliveryResult } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as AgentActivityPublisher from "./AgentActivityPublisher.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";

const layerPublisher = AgentActivityPublisher.layer.pipe(
  Layer.provide(
    Layer.succeed(FcmDeliveries.FcmDeliveries, {
      enqueue: () => Effect.succeed(null),
      process: () => Effect.void,
    }),
  ),
);

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};

function target(deviceId: string): LiveActivities.TargetRow {
  return {
    user_id: "dev:julius",
    device_id: deviceId,
    platform: "ios",
    ios_major_version: 18,
    app_version: "1.0.0",
    bundle_id: null,
    aps_environment: null,
    push_token: null,
    push_to_start_token: "start-token",
    preferences_json: "{}",
    activity_push_token: null,
    remote_start_queued_at: null,
    remote_started_at: null,
    ended_at: null,
    last_aggregate_json: null,
    last_live_activity_delivery_at: null,
  };
}

function makeLiveActivities(
  overrides: Partial<LiveActivities.LiveActivities["Service"]> = {},
): LiveActivities.LiveActivities["Service"] {
  return {
    register: () => Effect.void,
    listTargets: () => Effect.succeed([]),
    listIdleArmedTargets: () => Effect.succeed([]),
    markDelivery: () => Effect.void,

    invalidateDeliveryToken: () => Effect.void,
    ...overrides,
  };
}

function makeAgentActivityRows(
  overrides: Partial<AgentActivityRows.AgentActivityRows["Service"]> = {},
): AgentActivityRows.AgentActivityRows["Service"] {
  return {
    upsert: () => Effect.succeed(null),
    remove: () => Effect.void,
    pruneTerminal: () => Effect.void,
    markAlertUnsent: () => Effect.void,
    listForUser: () => Effect.succeed([state]),
    getForUserThread: () => Effect.succeed(state),
    ...overrides,
  };
}

function makeEnvironmentLinks(
  overrides: Partial<EnvironmentLinks.EnvironmentLinks["Service"]> = {},
): EnvironmentLinks.EnvironmentLinks["Service"] {
  return {
    upsert: () => Effect.succeed(null),
    listDeliveryUsersForEnvironment: () =>
      Effect.succeed([
        {
          userId: "dev:julius",
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
        },
      ]),
    listForUser: () => Effect.succeed([]),
    getForUser: () => Effect.succeed(null),
    findActiveManagedForEnvironment: () => Effect.succeed([]),
    setHoldWebhooksWhileOffline: () => Effect.void,
    revokeForUser: () => Effect.succeed(false),
    ...overrides,
  };
}

function makeApnsDeliveries(
  overrides: Partial<ApnsDeliveries.ApnsDeliveries["Service"]> = {},
): ApnsDeliveries.ApnsDeliveries["Service"] {
  return {
    sendForTarget: () => Effect.succeed(null),
    sendPushNotificationForTarget: () => Effect.succeed(null),
    sendLiveActivity: () =>
      Effect.succeed({
        deviceId: "device",
        kind: "live_activity_start",
        ok: true,
        apnsStatus: 200,
        apnsReason: null,
        apnsId: "apns-id",
      }),
    sendPushNotification: () =>
      Effect.succeed({
        deviceId: "device",
        kind: "push_notification",
        ok: true,
        apnsStatus: 200,
        apnsReason: null,
        apnsId: "apns-id",
      }),
    processSignedJob: () =>
      Effect.succeed({
        deviceId: "device",
        kind: "live_activity_start",
        ok: true,
        apnsStatus: 200,
        apnsReason: null,
        apnsId: "apns-id",
      }),
    ...overrides,
  };
}

describe("AgentActivityPublisher", () => {
  it.effect("routes Android publication and registration replay to FCM alongside iOS", () => {
    const android = { ...target("android"), platform: "android" as const, ios_major_version: null };
    const ios = target("ios");
    const fcmCalls: Array<Parameters<FcmDeliveries.FcmDeliveries["Service"]["enqueue"]>[0]> = [];
    const appleDevices: string[] = [];
    return Effect.gen(function* () {
      const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
      yield* publisher.publish({
        environmentId: state.environmentId,
        environmentPublicKey: "key",
        threadId: state.threadId,
        state,
      });
      yield* publisher.replayForLiveActivityRegistration({
        userId: android.user_id,
        deviceId: android.device_id,
      });
      expect(fcmCalls).toEqual([
        { target: android, state, trigger: false },
        { target: android, state: null, replay: true },
      ]);
      expect(appleDevices).toEqual(["ios"]);
    }).pipe(
      Effect.provide(
        AgentActivityPublisher.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AgentActivityRows.AgentActivityRows, makeAgentActivityRows()),
              Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeEnvironmentLinks()),
              Layer.succeed(
                LiveActivities.LiveActivities,
                makeLiveActivities({ listTargets: () => Effect.succeed([android, ios]) }),
              ),
              Layer.succeed(
                ApnsDeliveries.ApnsDeliveries,
                makeApnsDeliveries({
                  sendForTarget: (input) =>
                    Effect.sync(() => {
                      appleDevices.push(input.target.device_id);
                      return null;
                    }),
                }),
              ),
              Layer.succeed(FcmDeliveries.FcmDeliveries, {
                enqueue: (input) =>
                  Effect.sync(() => {
                    fcmCalls.push(input);
                    return null;
                  }),
                process: () => Effect.void,
              }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("alerts once per occurrence on iOS and Android, again after a failed publish", () => {
    const android = { ...target("android"), platform: "android" as const, ios_major_version: null };
    const stored = new Map<string, { state: RelayAgentActivityState; alertUnsent: boolean }>();
    let failTargetListing = false;
    const appleTriggers: Array<RelayAgentActivityState | null | undefined> = [];
    const androidTriggers: Array<boolean | undefined> = [];
    const completed = {
      ...state,
      phase: "completed",
      occurredAt: "1970-01-01T00:01:00.000Z",
      updatedAt: "1970-01-01T00:01:00.000Z",
    } satisfies RelayAgentActivityState;
    const renamed = { ...completed, threadTitle: "Renamed", updatedAt: "1970-01-01T00:02:00.000Z" };
    const second = {
      ...completed,
      occurredAt: "1970-01-01T00:03:00.000Z",
      updatedAt: "1970-01-01T00:03:00.000Z",
    };
    const legacyWaiting = {
      ...state,
      phase: "waiting_for_input",
    } satisfies RelayAgentActivityState;
    return Effect.gen(function* () {
      const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
      const publish = (next: RelayAgentActivityState) =>
        publisher.publish({
          environmentId: next.environmentId,
          environmentPublicKey: "key",
          threadId: next.threadId,
          state: next,
        });
      for (const next of [state, completed, renamed, renamed]) yield* publish(next);
      failTargetListing = true;
      expect(Exit.isFailure(yield* Effect.exit(publish(second)))).toBe(true);
      for (const next of [second, second, legacyWaiting, legacyWaiting]) yield* publish(next);
      expect(appleTriggers).toEqual([
        null,
        completed,
        null,
        null,
        second,
        null,
        legacyWaiting,
        null,
      ]);
      expect(androidTriggers).toEqual([false, true, false, false, true, false, true, false]);
    }).pipe(
      Effect.provide(
        AgentActivityPublisher.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                AgentActivityRows.AgentActivityRows,
                makeAgentActivityRows({
                  upsert: ({ state: next }) =>
                    Effect.sync(() => {
                      const previous = stored.get(next.threadId);
                      stored.set(next.threadId, { state: next, alertUnsent: false });
                      return previous
                        ? {
                            phase: previous.state.phase,
                            occurredAt: previous.state.occurredAt ?? null,
                            alertUnsent: previous.alertUnsent,
                          }
                        : null;
                    }),
                  markAlertUnsent: ({ state: sent }) =>
                    Effect.sync(() => {
                      const row = stored.get(sent.threadId);
                      if (row?.state === sent) row.alertUnsent = true;
                    }),
                }),
              ),
              Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeEnvironmentLinks()),
              Layer.succeed(
                LiveActivities.LiveActivities,
                makeLiveActivities({
                  listTargets: ({ userId }) => {
                    if (!failTargetListing) {
                      return Effect.succeed([
                        android,
                        { ...target("ios"), push_token: "apns-token" },
                      ]);
                    }
                    failTargetListing = false;
                    return Effect.fail(
                      new LiveActivities.LiveActivityTargetListPersistenceError({
                        userId,
                        cause: "connection reset",
                      }),
                    );
                  },
                }),
              ),
              Layer.succeed(
                ApnsDeliveries.ApnsDeliveries,
                makeApnsDeliveries({
                  sendForTarget: (input) =>
                    Effect.sync(() => {
                      appleTriggers.push(input.trigger);
                      return null;
                    }),
                }),
              ),
              Layer.succeed(FcmDeliveries.FcmDeliveries, {
                enqueue: (input) =>
                  Effect.sync(() => {
                    androidTriggers.push(input.trigger);
                    return null;
                  }),
                process: () => Effect.void,
              }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("replays the latest aggregate when a Live Activity token registers", () => {
    const registeredTarget: LiveActivities.TargetRow = {
      ...target("device-1"),
      push_to_start_token: null,
      activity_push_token: "activity-token",
      remote_start_queued_at: null,
      remote_started_at: "1970-01-01T00:00:01.000Z",
    };
    const sent: Array<Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendForTarget"]>[0]> =
      [];
    const deliveryResult: RelayDeliveryResult = {
      deviceId: "device-1",
      kind: "live_activity_update",
      ok: true,
      apnsStatus: null,
      apnsReason: null,
      apnsId: "queued",
    };

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
        return yield* publisher.replayForLiveActivityRegistration({
          userId: "dev:julius",
          deviceId: "device-1",
        });
      }).pipe(
        Effect.provide(
          layerPublisher.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentActivityRows.AgentActivityRows, makeAgentActivityRows()),
                Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeEnvironmentLinks()),
                Layer.succeed(
                  LiveActivities.LiveActivities,
                  makeLiveActivities({
                    listTargets: () => Effect.succeed([registeredTarget, target("device-2")]),
                  }),
                ),
                Layer.succeed(
                  ApnsDeliveries.ApnsDeliveries,
                  makeApnsDeliveries({
                    sendForTarget: (input) =>
                      Effect.sync(() => {
                        sent.push(input);
                        return deliveryResult;
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result).toEqual(deliveryResult);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.target.device_id).toBe("device-1");
      expect(sent[0]?.aggregate).toMatchObject({
        activeCount: 1,
        activities: [
          {
            environmentId: state.environmentId,
            threadId: state.threadId,
            status: "Working",
          },
        ],
      });
    });
  });

  it.effect(
    "delivers notifications without querying activity rows when Live Activities are disabled",
    () => {
      const notificationState: RelayAgentActivityState = {
        ...state,
        phase: "waiting_for_approval",
        headline: "Needs approval",
      };
      const liveAggregates: Array<
        Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendForTarget"]>[0]
      > = [];
      const pushAggregates: Array<
        Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendPushNotificationForTarget"]>[0]
      > = [];

      return Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
          return yield* publisher.publish({
            environmentId: "env",
            environmentPublicKey: "environment-public-key",
            threadId: "thread",
            state: notificationState,
          });
        }).pipe(
          Effect.provide(
            layerPublisher.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    AgentActivityRows.AgentActivityRows,
                    makeAgentActivityRows({
                      listForUser: () =>
                        Effect.die("Notification-only delivery must not read rows"),
                    }),
                  ),
                  Layer.succeed(
                    EnvironmentLinks.EnvironmentLinks,
                    makeEnvironmentLinks({
                      listDeliveryUsersForEnvironment: () =>
                        Effect.succeed([
                          {
                            userId: "dev:julius",
                            notificationsEnabled: true,
                            liveActivitiesEnabled: false,
                          },
                        ]),
                    }),
                  ),
                  Layer.succeed(
                    LiveActivities.LiveActivities,
                    makeLiveActivities({
                      listTargets: () =>
                        Effect.succeed([
                          {
                            ...target("device-1"),
                            push_token: "apns-device-token",
                            push_to_start_token: "push-to-start-token",
                          },
                        ]),
                    }),
                  ),
                  Layer.succeed(
                    ApnsDeliveries.ApnsDeliveries,
                    makeApnsDeliveries({
                      sendForTarget: (input) =>
                        Effect.sync(() => {
                          liveAggregates.push(input);
                          return null;
                        }),
                      sendPushNotificationForTarget: (input) =>
                        Effect.sync(() => {
                          pushAggregates.push(input);
                          return {
                            deviceId: input.target.device_id,
                            kind: "push_notification",
                            ok: true,
                            queued: true,
                            apnsStatus: null,
                            apnsReason: null,
                            apnsId: null,
                          };
                        }),
                    }),
                  ),
                ),
              ),
            ),
          ),
        );

        expect(liveAggregates).toMatchObject([{ aggregate: null }]);
        expect(pushAggregates).toHaveLength(1);
        expect(pushAggregates[0]?.trigger).toEqual(notificationState);
        expect(result.deliveries).toMatchObject([
          {
            deviceId: "device-1",
            kind: "push_notification",
            queued: true,
          },
        ]);
      });
    },
  );
});

describe("isExpiredAgentActivityState", () => {
  it("treats rows with unparseable timestamps as expired", () => {
    expect(
      AgentActivityPublisher.isExpiredAgentActivityState({ ...state, updatedAt: "not-a-date" }, 0),
    ).toBe(true);
  });
});

describe("makeAggregateState", () => {
  const hourMs = 60 * 60 * 1_000;

  it("drops expired rows from the aggregate", () => {
    const fresh: RelayAgentActivityState = {
      ...state,
      threadId: "thread-fresh" as RelayAgentActivityState["threadId"],
      updatedAt: "1970-01-01T03:00:00.000Z",
    };
    const aggregate = makeAggregateState({
      activeStates: [state, fresh],
      terminalState: null,
      nowMs: 3 * hourMs,
    });

    expect(aggregate?.activeCount).toBe(1);
    expect(aggregate?.activities).toMatchObject([{ threadId: "thread-fresh" }]);
  });

  it("returns null when every row has expired and nothing terminal remains", () => {
    expect(
      makeAggregateState({
        activeStates: [state],
        terminalState: null,
        nowMs: 3 * hourMs,
      }),
    ).toBeNull();
  });

  it("still reports the terminal state when active rows have expired", () => {
    const terminalState: RelayAgentActivityState = {
      ...state,
      phase: "completed",
      updatedAt: "1970-01-01T03:00:00.000Z",
    };
    const aggregate = makeAggregateState({
      activeStates: [state],
      terminalState,
      nowMs: 3 * hourMs,
    });

    expect(aggregate?.activeCount).toBe(0);
    expect(aggregate?.activities).toMatchObject([{ phase: "completed" }]);
  });

  it("keeps a recently finished thread visible as Done beside active agents", () => {
    const active: RelayAgentActivityState = {
      ...state,
      threadId: "thread-active" as RelayAgentActivityState["threadId"],
      updatedAt: "1970-01-01T00:58:00.000Z",
    };
    const justCompleted: RelayAgentActivityState = {
      ...state,
      threadId: "thread-done" as RelayAgentActivityState["threadId"],
      phase: "completed",
      updatedAt: "1970-01-01T00:59:00.000Z",
    };
    const aggregate = makeAggregateState({
      activeStates: [active, justCompleted],
      terminalState: null,
      nowMs: hourMs,
    });

    expect(aggregate?.activeCount).toBe(1);
    expect(aggregate?.subtitle).toBe("Agent work in progress");
    expect(aggregate?.activities).toMatchObject([
      { threadId: "thread-active", phase: "running" },
      { threadId: "thread-done", phase: "completed", status: "Done" },
    ]);
    expect(aggregate?.updatedAt).toBe("1970-01-01T00:59:00.000Z");
  });

  it("keeps showing recently finished work when nothing is active", () => {
    const lingeringCompleted: RelayAgentActivityState = {
      ...state,
      phase: "completed",
      updatedAt: "1970-01-01T00:59:00.000Z",
    };
    const aggregate = makeAggregateState({
      activeStates: [lingeringCompleted],
      terminalState: null,
      nowMs: hourMs,
    });

    expect(aggregate).toMatchObject({
      activeCount: 0,
      subtitle: "Agent work completed",
      activities: [{ phase: "completed", status: "Done" }],
    });
    expect(
      makeAggregateState({
        activeStates: [{ ...lingeringCompleted, updatedAt: "1970-01-01T00:44:00.000Z" }],
        terminalState: null,
        nowMs: hourMs,
      }),
    ).toBeNull();
  });

  it("gives active agents the display slots before finished ones", () => {
    const mkActive = (id: string): RelayAgentActivityState => ({
      ...state,
      threadId: id as RelayAgentActivityState["threadId"],
      updatedAt: "1970-01-01T00:58:00.000Z",
    });
    const justCompleted: RelayAgentActivityState = {
      ...state,
      threadId: "thread-done" as RelayAgentActivityState["threadId"],
      phase: "completed",
      updatedAt: "1970-01-01T00:59:00.000Z",
    };
    const aggregate = makeAggregateState({
      activeStates: [
        mkActive("a-1"),
        mkActive("a-2"),
        mkActive("a-3"),
        mkActive("a-4"),
        mkActive("a-5"),
        justCompleted,
      ],
      terminalState: null,
      nowMs: hourMs,
    });

    expect(aggregate?.activeCount).toBe(5);
    expect(aggregate?.activities).toMatchObject([
      { threadId: "a-1" },
      { threadId: "a-2" },
      { threadId: "a-3" },
      { threadId: "a-4" },
      { threadId: "a-5" },
    ]);
  });
});
