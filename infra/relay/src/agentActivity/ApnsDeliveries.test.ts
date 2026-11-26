import { PGlite } from "@electric-sql/pglite";
import { PgClient } from "@effect/sql-pg/PgClient";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as RelayDb from "../db.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  type SignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsDeliveryQueueConsumer from "./ApnsDeliveryQueueConsumer.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("not-a-private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-signing-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const apnsSigningKeyPair = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const signingConfig = RelayConfiguration.RelayConfiguration.of({
  ...config,
  apns: {
    ...config.apns!,
    privateKey: Redacted.make(apnsSigningKeyPair.privateKey),
  },
});

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};

const aggregate: RelayAgentActivityAggregateState = {
  title: "T3.CodeShip",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: state.updatedAt,
  activities: [
    {
      environmentId: state.environmentId,
      threadId: state.threadId,
      projectTitle: state.projectTitle,
      threadTitle: state.threadTitle,
      modelTitle: state.modelTitle,
      phase: state.phase,
      status: "Working",
      updatedAt: state.updatedAt,
      deepLink: state.deepLink,
    },
  ],
};

const enabledPreferences = JSON.stringify({
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const disabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const notificationsDisabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const target: LiveActivities.TargetRow = {
  user_id: "dev:julius",
  device_id: "device-1",
  platform: "ios",
  ios_major_version: 18,
  app_version: "1.0.0",
  bundle_id: null,
  aps_environment: null,
  push_token: null,
  push_to_start_token: "start-token",
  preferences_json: enabledPreferences,
  activity_push_token: "activity-token",
  remote_start_queued_at: null,
  remote_started_at: "1970-01-01T00:00:00.000Z",
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};

function layerFor(input: {
  readonly attempts: Array<DeliveryAttempts.DeliveryAttemptInput>;
  readonly activityRows?: AgentActivityRows.AgentActivityRows["Service"];
  readonly sourceJobClaims?: ReadonlyMap<string, DeliveryAttempts.DeliverySourceJobClaimResult>;
  readonly queuedJobs?: Array<SignedApnsDeliveryJob>;
  readonly markedDeliveries?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["markDelivery"]>[0]
  >;
  readonly invalidatedTokens?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
  >;
  readonly currentTargets?: ReadonlyArray<LiveActivities.TargetRow>;
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  readonly activityStates?: ReadonlyArray<RelayAgentActivityState>;
  readonly currentActivityStates?: ReadonlyArray<RelayAgentActivityState>;
  readonly notificationsAllowed?: boolean;
  readonly failActivityLookup?: () => boolean;
  readonly failAggregateLookup?: () => boolean;
  readonly activityRecheckFails?: boolean;
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) {
  return ApnsDeliveries.layer.pipe(
    Layer.provideMerge(NodeCryptoLayer.layerMac),
    Layer.provide(ApnsClient.layer),
    Layer.provide(ApnsProviderTokens.layer),
    Layer.provide(ApnsDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AgentActivityRows.AgentActivityRows,
          input.activityRows ??
            ({
              upsert: () => Effect.succeed(null),
              remove: () => Effect.void,
              pruneTerminal: () => Effect.void,
              markAlertUnsent: () => Effect.void,
              listForUser: ({ userId }) =>
                Effect.suspend(() =>
                  input.failAggregateLookup?.()
                    ? Effect.fail(
                        new AgentActivityRows.AgentActivityRowListPersistenceError({
                          userId,
                          cause: "transient database error",
                        }),
                      )
                    : Effect.succeed(input.activityStates ?? [state]),
                ),
              getForUserThread: (lookup) =>
                Effect.suspend(() =>
                  input.failActivityLookup?.() ||
                  (input.activityRecheckFails && !lookup.requireNotifications)
                    ? Effect.fail(
                        new AgentActivityRows.AgentActivityRowListPersistenceError({
                          userId: lookup.userId,
                          cause: "transient database error",
                        }),
                      )
                    : Effect.succeed(
                        lookup.requireNotifications === true && input.notificationsAllowed === false
                          ? null
                          : ((input.currentActivityStates ?? input.activityStates ?? [state]).find(
                              (current) =>
                                current.environmentId === lookup.environmentId &&
                                current.threadId === lookup.threadId,
                            ) ?? null),
                      ),
                ),
            } satisfies AgentActivityRows.AgentActivityRows["Service"]),
        ),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              input.queuedJobs?.push(body);
            }),
        }),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
          pruneExpired: Effect.succeed(0),
          claimSourceJob: (attempt) =>
            Effect.sync(() => {
              const claim = input.sourceJobClaims?.get(attempt.sourceJobId);
              if (claim) {
                return claim;
              }
              input.attempts.push(attempt);
              return "claimed";
            }),
          completeSourceJob: (completion) =>
            Effect.sync(() => {
              const attempt = input.attempts.find(
                (row) => row.sourceJobId === completion.sourceJobId,
              );
              if (attempt) {
                Object.assign(attempt, completion);
              }
            }),
        }),
        Layer.succeed(LiveActivities.LiveActivities, {
          register: () => Effect.void,
          listTargets: () => Effect.succeed(input.currentTargets ?? [target]),
          listIdleArmedTargets: () => Effect.succeed([]),
          markDelivery: (delivery) =>
            Effect.sync(() => {
              input.markedDeliveries?.push(delivery);
            }),
          invalidateDeliveryToken: (invalidated) =>
            Effect.sync(() => {
              input.invalidatedTokens?.push(invalidated);
            }),
        }),
        RelayConfiguration.layer(input.config ?? config),
        input.execute
          ? Layer.succeed(HttpClient.HttpClient, HttpClient.make(input.execute))
          : FetchHttpClient.layer,
      ),
    ),
  );
}

describe("ApnsDeliveries", () => {
  it.effect("queues bounded Live Activity aggregate payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const longTitle = "x".repeat(300);
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      title: longTitle,
      subtitle: longTitle,
      activities: [0, 1, 2, 3, 4, 5].map((index) =>
        Object.assign({}, aggregate.activities[0]!, {
          projectTitle: longTitle,
          threadTitle: longTitle,
          modelTitle: longTitle,
          status: longTitle,
          threadId: `thread-${index}` as RelayAgentActivityState["threadId"],
          deepLink: "https://example.test/not-an-app-link",
        }),
      ),
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target,
        aggregate: inputAggregate,
        nowMs: 10_000,
      });

      const payloadAggregate = queuedJobs[0]?.payload.aggregate;
      expect(payloadAggregate?.title.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.subtitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities).toHaveLength(5);
      expect(payloadAggregate?.activities[0]?.projectTitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities[0]?.status.length).toBeLessThanOrEqual(40);
      expect(payloadAggregate?.activities[0]?.deepLink).toBe("/");
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect.each([
    {
      label: "connecting becomes working",
      previousRows: [{ ...aggregate.activities[0]!, phase: "starting", status: "Connecting" }],
    },
    {
      label: "input resumes working",
      previousRows: [{ ...aggregate.activities[0]!, phase: "waiting_for_input", status: "Input" }],
    },
    {
      label: "a settled terminal row leaves",
      previousRows: [
        aggregate.activities[0]!,
        {
          ...aggregate.activities[0]!,
          threadId: ThreadId.make("finished"),
          phase: "completed",
          status: "Done",
        },
      ],
    },
    {
      label: "the same thread id moves to another environment",
      previousRows: [
        { ...aggregate.activities[0]!, environmentId: EnvironmentId.make("other-env") },
      ],
    },
  ] as const)("queues an update inside the throttle window when $label", ({ previousRows }) => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const previousAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: previousRows,
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          last_aggregate_json: JSON.stringify(previousAggregate),
          last_live_activity_delivery_at: "1970-01-01T00:00:04.000Z",
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result?.kind).toBe("live_activity_update");
      expect(queuedJobs).toMatchObject([{ payload: { kind: "live_activity_update", aggregate } }]);
      expect(queuedJobs[0]?.payload.alert ?? null).toBeNull();
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect.each([
    { label: "inside", nowMs: 5_000, queued: false },
    { label: "after", nowMs: 19_000, queued: true },
  ])("throttles timestamp-only updates $label the window", ({ nowMs, queued }) => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const changedAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      updatedAt: "1970-01-01T00:00:04.000Z",
      activities: [{ ...aggregate.activities[0]!, updatedAt: "1970-01-01T00:00:04.000Z" }],
    };
    const previousAggregateJson = JSON.stringify(aggregate);

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          last_aggregate_json: previousAggregateJson,
          last_live_activity_delivery_at: "1970-01-01T00:00:04.000Z",
        },
        aggregate: changedAggregate,
        nowMs,
      });

      expect(result?.kind ?? null).toBe(queued ? "live_activity_update" : null);
      expect(queuedJobs).toHaveLength(queued ? 1 : 0);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect(
    "queues an alert while ending an active Live Activity when only Live Activities are disabled",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const inputAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            push_token: "apns-device-token",
            preferences_json: disabledPreferences,
          },
          aggregate: inputAggregate,
          nowMs: 5_000,
          trigger: { ...state, ...inputAggregate.activities[0]! },
        });

        expect(result?.kind).toBe("live_activity_end");
        expect(queuedJobs).toMatchObject([
          {
            payload: {
              kind: "live_activity_end",
              target: {
                token: "activity-token",
              },
            },
          },
          {
            payload: {
              kind: "push_notification",
              target: {
                token: "apns-device-token",
              },
              notification: {
                title: "Thread",
                body: "Input: Project",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
                phase: "waiting_for_input",
                updatedAt: state.updatedAt,
              },
            },
          },
        ]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
    },
  );

  it.effect(
    "queues the triggering completion when an eligible approval is displayed first and no card token exists",
    () => {
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const secondThreadId = ThreadId.make("finished");
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        yield* deliveries.sendForTarget({
          target: { ...target, activity_push_token: null, push_token: "apns-device-token" },
          nowMs: 0,
          trigger: {
            ...state,
            threadId: secondThreadId,
            phase: "completed",
            notificationLevel: "following",
          },
          aggregate: {
            ...aggregate,
            activities: [
              {
                ...aggregate.activities[0]!,
                phase: "waiting_for_approval",
              },
              { ...aggregate.activities[0]!, threadId: secondThreadId, phase: "completed" },
            ],
          },
        });
        expect(queuedJobs).toMatchObject([
          { payload: { kind: "push_notification", notification: { threadId: secondThreadId } } },
        ]);
      }).pipe(Effect.provide(layerFor({ attempts: [], queuedJobs })));
    },
  );

  it.effect("does not queue alert pushes when notification permission is disabled", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: [
        {
          ...aggregate.activities[0]!,
          phase: "waiting_for_input",
          notificationLevel: "following",
          status: "Input",
        },
      ],
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          push_token: "apns-device-token",
          preferences_json: notificationsDisabledPreferences,
        },
        aggregate: inputAggregate,
        nowMs: 5_000,
        trigger: { ...state, ...inputAggregate.activities[0]! },
      });

      expect(result?.kind).toBe("live_activity_end");
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_end",
            target: {
              token: "activity-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect(
    "queues a push notification for approval and input states when no Live Activity delivery is available",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const inputAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            push_token: "apns-device-token",
            push_to_start_token: null,
            activity_push_token: null,
            remote_started_at: null,
          },
          aggregate: inputAggregate,
          nowMs: 5_000,
          trigger: { ...state, ...inputAggregate.activities[0]! },
        });

        expect(result?.kind).toBe("push_notification");
        expect(result?.ok).toBe(true);
        expect(queuedJobs).toMatchObject([
          {
            payload: {
              kind: "push_notification",
              target: {
                token: "apns-device-token",
              },
              notification: {
                title: "Thread",
                body: "Input: Project",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
              },
            },
          },
        ]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
    },
  );

  it.effect("push-only alerts describe the published thread, never a stale aggregate row", () => {
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const pushOnly = {
      ...target,
      push_token: "apns-device-token",
      push_to_start_token: null,
      activity_push_token: null,
      remote_started_at: null,
    };
    const completed = { ...state, phase: "completed" as const };
    const doneAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activeCount: 0,
      activities: [{ ...aggregate.activities[0]!, phase: "completed", status: "Done" }],
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: pushOnly,
        aggregate: doneAggregate,
        trigger: completed,
        nowMs: 5_000,
      });
      yield* deliveries.sendForTarget({
        target: pushOnly,
        aggregate: doneAggregate,
        trigger: null,
        nowMs: 6_000,
      });
      const unrelated: RelayAgentActivityState = {
        ...state,
        threadId: "other-thread" as RelayAgentActivityState["threadId"],
        threadTitle: "Other thread",
        projectTitle: "Other project",
        deepLink: "/threads/env/other-thread",
      };
      yield* deliveries.sendForTarget({
        target: pushOnly,
        aggregate: doneAggregate,
        trigger: unrelated,
        nowMs: 7_000,
      });
      yield* deliveries.sendForTarget({
        target: pushOnly,
        aggregate: doneAggregate,
        trigger: { ...unrelated, phase: "waiting_for_input" },
        nowMs: 8_000,
      });

      expect(queuedJobs.map((job) => job.payload)).toMatchObject([
        {
          kind: "push_notification",
          notification: { title: "Thread", body: "Done: Project", threadId: "thread" },
        },
        {
          kind: "push_notification",
          notification: {
            title: "Other thread",
            body: "Input: Other project",
            threadId: "other-thread",
            deepLink: "/threads/env/other-thread",
          },
        },
      ]);
    }).pipe(Effect.provide(layerFor({ attempts: [], queuedJobs })));
  });

  it.effect("queues bounded alert notification payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const longTitle = "x".repeat(300);
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: [
        {
          ...aggregate.activities[0]!,
          projectTitle: longTitle,
          threadTitle: longTitle,
          phase: "waiting_for_input",
          status: "Input",
          deepLink: "https://example.test/not-an-app-link",
        },
      ],
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: {
          ...target,
          push_token: "apns-device-token",
          push_to_start_token: null,
          activity_push_token: null,
          remote_started_at: null,
        },
        aggregate: inputAggregate,
        nowMs: 5_000,
        trigger: { ...state, ...inputAggregate.activities[0]! },
      });

      const notification = queuedJobs[0]?.payload.notification;
      expect(notification?.title.length).toBeLessThanOrEqual(120);
      expect(notification?.body.length).toBeLessThanOrEqual(120);
      expect(notification?.deepLink).toBe("/");
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect.each([
    { phase: "running", updatedAt: state.updatedAt, disabled: false, sends: false },
    { phase: "completed", updatedAt: state.updatedAt, disabled: false, sends: false },
    { phase: "completed", updatedAt: "1969-12-31T23:44:00.000Z", disabled: false, sends: true },
    { phase: "running", updatedAt: state.updatedAt, disabled: true, sends: true },
  ] as const)(
    "rechecks a queued contentless end: $phase at $updatedAt, disabled=$disabled",
    ({ phase, updatedAt, disabled, sends }) => {
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const signedEnd = signApnsDeliveryJob({
        secret: config.apnsDeliveryJobSigningSecret,
        payload: makeApnsDeliveryJobPayload({
          kind: "live_activity_end",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "activity-token",
          aggregate: null,
          createdAt: state.updatedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-end-1",
        }),
      });
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.processSignedJob(yield* signedEnd);
        expect(result.ok).toBe(true);
        expect(requests).toHaveLength(sends ? 1 : 0);
        if (sends) {
          const request = requests[0]!;
          expect(request.url).toBe("https://api.sandbox.push.apple.com/3/device/activity-token");
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag === "Uint8Array") {
            const { aps } = JSON.parse(new TextDecoder().decode(request.body.body));
            expect(aps.event).toBe("end");
            expect(aps.alert).toBeUndefined();
            expect(aps.sound).toBeUndefined();
          }
        }
      }).pipe(
        Effect.provide(
          layerFor({
            attempts: [],
            config: signingConfig,
            currentTargets: [
              { ...target, preferences_json: disabled ? disabledPreferences : enabledPreferences },
            ],
            activityStates: [{ ...state, phase, updatedAt }],
            execute: (request) =>
              Effect.sync(() => {
                requests.push(request);
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    },
  );

  it.effect.each([false, true])(
    "checks the current level of a legacy push (muted: %s)",
    (muted) => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const payload = makeApnsDeliveryJobPayload({
        kind: "push_notification",
        userId: target.user_id,
        deviceId: target.device_id,
        token: "apns-device-token",
        aggregate: null,
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env",
          threadId: "thread",
          deepLink: "/",
        },
        createdAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:10:00.000Z",
        jobId: "job-push-1",
      });
      const signed = signApnsDeliveryJob({
        secret: config.apnsDeliveryJobSigningSecret,
        payload,
      });
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })));

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.processSignedJob(yield* signed);

        expect(result.kind).toBe("push_notification");
        expect(result.ok).toBe(true);
        expect(result.apnsStatus).toBe(muted ? null : 200);
        expect(attempts).toMatchObject([
          {
            kind: "push_notification",
            sourceJobId: "job-push-1",
            token: "apns-device-token",
            environmentId: "env",
            threadId: "thread",
            deviceId: target.device_id,
            ...(muted ? {} : { apnsStatus: 200 }),
          },
        ]);
      }).pipe(
        Effect.provide(
          layerFor({
            attempts,
            currentTargets: [
              {
                ...target,
                push_token: "apns-device-token",
              },
            ],
            activityStates: [
              {
                ...state,
                phase: "waiting_for_input",
                notificationLevel: muted ? "muted" : "default",
              },
            ],
            config: signingConfig,
            execute,
          }),
        ),
      );
    },
  );
  it.effect.each([
    { phase: "completed", level: "following", delivers: true, retry: false },
    { phase: "completed", level: "following", delivers: true, retry: true },
    { phase: "completed", level: "muted", delivers: false, retry: false },
    { phase: "waiting_for_approval", level: "muted", delivers: false, retry: false },
  ] as const)(
    "checks a queued $phase push against the current $level level (retry: $retry)",
    ({ phase, level, delivers, retry }) => {
      let shouldFail = retry;
      let sent = 0;
      const payload = makeApnsDeliveryJobPayload({
        kind: "push_notification",
        userId: target.user_id,
        deviceId: target.device_id,
        token: "apns-device-token",
        aggregate: null,
        notification: {
          title: "Thread",
          body: "Project",
          environmentId: state.environmentId,
          threadId: state.threadId,
          deepLink: "/",
          phase,
          updatedAt: state.updatedAt,
        },
        createdAt: state.updatedAt,
        expiresAt: "1970-01-01T00:10:00.000Z",
        jobId: "job-push-level-changed",
      });
      const signed = signApnsDeliveryJob({ secret: config.apnsDeliveryJobSigningSecret, payload });
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        if (retry) {
          const unavailable = yield* Effect.exit(deliveries.processSignedJob(yield* signed));
          expect(unavailable._tag).toBe("Failure");
          expect(sent).toBe(0);
        }
        const result = yield* deliveries.processSignedJob(yield* signed);
        expect(result.apnsStatus).toBe(delivers ? 200 : null);
        expect(sent).toBe(delivers ? 1 : 0);
      }).pipe(
        Effect.provide(
          layerFor({
            attempts: [],
            currentTargets: [{ ...target, push_token: "apns-device-token" }],
            activityStates: [{ ...state, phase, notificationLevel: level }],
            config: signingConfig,
            failActivityLookup: () => {
              const fail = shouldFail;
              shouldFail = false;
              return fail;
            },
            execute: (request) =>
              Effect.sync(() => {
                sent += 1;
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    },
  );
  it.effect.each([
    { level: "following", alertTitle: "Thread" },
    { level: "muted", alertTitle: undefined },
  ] as const)(
    "rechecks approval eligibility after an aggregate row changes to $level",
    ({ level, alertTitle }) => {
      const approval = { ...state, phase: "waiting_for_approval" as const };
      const other = { ...state, threadId: ThreadId.make("other"), threadTitle: "Other" };
      const currentStates = [
        { ...approval, notificationLevel: level },
        { ...other, notificationLevel: "muted" as const },
      ];
      const payload = makeApnsDeliveryJobPayload({
        kind: "live_activity_update",
        userId: target.user_id,
        deviceId: target.device_id,
        token: target.activity_push_token!,
        aggregate: {
          ...aggregate,
          activities: [
            { ...aggregate.activities[0]!, phase: approval.phase, status: "Approval" },
            {
              ...aggregate.activities[0]!,
              threadId: other.threadId,
              threadTitle: other.threadTitle,
            },
          ],
        },
        alert: {
          title: "Thread",
          body: "Approval: Project",
          activity: {
            environmentId: approval.environmentId,
            threadId: approval.threadId,
            phase: approval.phase,
            updatedAt: approval.updatedAt,
          },
        },
        createdAt: state.updatedAt,
        expiresAt: "1970-01-01T00:10:00.000Z",
        jobId: "job-update-level-changed",
      });
      const signed = signApnsDeliveryJob({ secret: config.apnsDeliveryJobSigningSecret, payload });
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.processSignedJob(yield* signed);
        expect(result.apnsStatus).toBe(200);
      }).pipe(
        Effect.provide(
          layerFor({
            attempts: [],
            currentTargets: [
              {
                ...target,
                push_token: "apns-device-token",
                last_aggregate_json: JSON.stringify(aggregate),
              },
            ],
            activityStates: currentStates,
            config: signingConfig,
            execute: (request) =>
              Effect.sync(() => {
                expect(request.body._tag).toBe("Uint8Array");
                if (request.body._tag === "Uint8Array") {
                  const { aps } = JSON.parse(new TextDecoder().decode(request.body.body));
                  expect(aps.alert?.title).toBe(alertTitle);
                }
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    },
  );
  it.effect.each([
    { name: "records the APNs attempt", activityRecheckFails: false },
    { name: "skips the job when the activity recheck fails", activityRecheckFails: true },
  ])("processes signed push notification jobs: $name", ({ activityRecheckFails }) => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let apnsRequests = 0;
    const waiting = { ...state, phase: "waiting_for_input" as const };
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
        phase: waiting.phase,
        updatedAt: waiting.updatedAt,
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        apnsRequests += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(yield* signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(true);
      expect(apnsRequests).toBe(activityRecheckFails ? 0 : 1);
      expect(attempts).toMatchObject([
        {
          kind: "push_notification",
          sourceJobId: "job-push-1",
          token: "apns-device-token",
          environmentId: "env",
          threadId: "thread",
          deviceId: target.device_id,
          ...(activityRecheckFails
            ? { apnsReason: "Stale agent activity state skipped." }
            : { apnsStatus: 200 }),
        },
      ]);
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          currentTargets: [
            {
              ...target,
              push_token: "apns-device-token",
            },
          ],
          config: signingConfig,
          currentActivityStates: [waiting],
          activityRecheckFails,
          execute,
        }),
      ),
    );
  });

  it.effect("delivers to other devices without reordering a device's queued jobs", () =>
    Effect.gen(function* () {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const requests: Array<string> = [];
      let firstDeviceRequest = true;
      const firstStarted = yield* Deferred.make<void>();
      const otherDeviceDelivered = yield* Deferred.make<void>();
      const devices = [
        { ...target, push_token: "first-token" },
        { ...target, device_id: "device-2", push_token: "other-token" },
      ];
      const jobs = yield* Effect.forEach([devices[0]!, devices[0]!, devices[1]!], (device, i) =>
        signApnsDeliveryJob({
          secret: signingConfig.apnsDeliveryJobSigningSecret,
          payload: makeApnsDeliveryJobPayload({
            kind: "push_notification",
            userId: device.user_id,
            deviceId: device.device_id,
            token: device.push_token,
            aggregate: null,
            notification: {
              title: "Thread",
              body: "Done",
              environmentId: "env",
              threadId: `thread-${i}`,
              deepLink: "/",
              phase: "completed",
              updatedAt: state.updatedAt,
            },
            createdAt: "1970-01-01T00:00:00.000Z",
            expiresAt: "1970-01-01T00:10:00.000Z",
            jobId: `job-${i}`,
          }),
        }),
      );
      const batch = yield* ApnsDeliveryQueueConsumer.processBatch(
        Stream.fromIterable(
          jobs.map((body, index) => ({
            id: String(index),
            body,
            ack: () => {},
            retry: () => {
              throw new Error("Unexpected retry");
            },
          })),
        ),
      ).pipe(
        Effect.provide(
          layerFor({
            attempts,
            currentTargets: devices,
            activityStates: jobs.map(({ payload }) => ({
              ...state,
              phase: "completed",
              threadId: ThreadId.make(payload.notification!.threadId),
            })),
            config: signingConfig,
            execute: (request) =>
              Effect.gen(function* () {
                const token = request.url.split("/").at(-1)!;
                requests.push(token);
                if (request.url.endsWith("/other-token")) {
                  yield* Deferred.succeed(otherDeviceDelivered, undefined);
                } else if (firstDeviceRequest) {
                  firstDeviceRequest = false;
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(otherDeviceDelivered);
                }
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(batch);

      expect(requests).toHaveLength(3);
      expect(requests.filter((token) => token === "first-token")).toHaveLength(2);
      expect(requests.indexOf("other-token")).toBeLessThan(requests.lastIndexOf("first-token"));
      expect(attempts).toHaveLength(3);
      expect(
        attempts
          .filter((attempt) => attempt.deviceId === target.device_id)
          .map((attempt) => attempt.sourceJobId),
      ).toEqual(["job-0", "job-1"]);
      expect(attempts.every((attempt) => attempt.apnsStatus === 200)).toBe(true);
    }).pipe(Effect.provide(NodeCryptoLayer.layerMac)),
  );

  it.effect("skips duplicate signed queue jobs before calling APNs", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-duplicate",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(yield* signed);

      expect(result).toMatchObject({
        kind: "push_notification",
        ok: true,
        apnsStatus: null,
        apnsReason: "Duplicate APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toEqual([]);
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          sourceJobClaims: new Map([["job-push-duplicate", "completed"]]),
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips stale signed Live Activity jobs when the registered token changed", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "stale-activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-stale-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(yield* signed);

      expect(result).toMatchObject({
        kind: "live_activity_update",
        ok: true,
        apnsStatus: null,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toMatchObject([
        {
          kind: "live_activity_update",
          sourceJobId: "job-update-stale-token",
          token: "stale-activity-token",
          apnsReason: "Stale APNs delivery job skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect.each([true, false])(
    "skips a queued Done update that is no longer visible (thread resumed: %s)",
    (resumed) => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      let executeCount = 0;
      const completedAt = "1970-01-01T00:00:01.000Z";
      const completedAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activeCount: 0,
        updatedAt: completedAt,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "completed",
            status: "Done",
            updatedAt: completedAt,
          },
        ],
      };
      const payload = makeApnsDeliveryJobPayload({
        kind: "live_activity_update",
        userId: target.user_id,
        deviceId: target.device_id,
        token: target.activity_push_token ?? "activity-token",
        aggregate: completedAggregate,
        alert: { title: "Thread", body: "Done: Project" },
        createdAt: completedAt,
        expiresAt: "1970-01-01T00:10:00.000Z",
        jobId: "job-update-superseded-by-running",
      });
      const signed = signApnsDeliveryJob({
        secret: config.apnsDeliveryJobSigningSecret,
        payload,
      });
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.sync(() => {
          executeCount += 1;
          return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
        });

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.processSignedJob(yield* signed);

        expect(result).toMatchObject({
          kind: "live_activity_update",
          ok: true,
          apnsStatus: null,
          apnsReason: "Stale APNs delivery job skipped.",
        });
        expect(executeCount).toBe(0);
        expect(attempts).toMatchObject([
          {
            sourceJobId: "job-update-superseded-by-running",
            apnsReason: "Stale agent activity state skipped.",
          },
        ]);
      }).pipe(
        Effect.provide(
          layerFor({
            attempts,
            activityStates: resumed
              ? [
                  {
                    ...state,
                    phase: "running",
                    headline: "Running",
                    updatedAt: "1970-01-01T00:00:02.000Z",
                  },
                ]
              : [],
            config: signingConfig,
            execute,
          }),
        ),
      );
    },
  );

  it.effect("retries an in-flight device's jobs without cancelling other devices", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-in-flight",
    });
    const signed = Effect.forEach(
      [
        payload,
        { ...payload, jobId: "job-push-after-in-flight" },
        {
          ...payload,
          jobId: "job-push-other-device",
          target: { ...payload.target, deviceId: "device-2", token: "other-token" },
        },
      ],
      (payload) => signApnsDeliveryJob({ secret: config.apnsDeliveryJobSigningSecret, payload }),
    );
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const outcomes = new Map<string, "ack" | "retry">();
      yield* ApnsDeliveryQueueConsumer.processBatch(
        Stream.fromIterable(
          (yield* signed).map((body) => ({
            id: body.payload.jobId,
            body,
            ack: () => outcomes.set(body.payload.jobId, "ack"),
            retry: () => outcomes.set(body.payload.jobId, "retry"),
          })),
        ),
      );

      expect(outcomes).toEqual(
        new Map([
          ["job-push-in-flight", "retry"],
          ["job-push-after-in-flight", "retry"],
          ["job-push-other-device", "ack"],
        ]),
      );
      expect(executeCount).toBe(1);
      expect(attempts).toMatchObject([{ sourceJobId: "job-push-other-device", apnsStatus: 200 }]);
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          sourceJobClaims: new Map([["job-push-in-flight", "in_flight"]]),
          currentTargets: [{ ...target, device_id: "device-2", push_token: "other-token" }],
          activityStates: [{ ...state, phase: "waiting_for_input" }],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect.each([
    {
      job: "in-flight",
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      outcome: "retry",
    },
    {
      job: "expired",
      createdAt: "1969-12-31T23:49:00.000Z",
      expiresAt: "1969-12-31T23:59:00.000Z",
      outcome: "ack",
    },
  ] as const)(
    "settles the $job signed queue job with $outcome",
    ({ job, createdAt, expiresAt, outcome }) => {
      const outcomes: Array<"ack" | "retry"> = [];
      const payload = makeApnsDeliveryJobPayload({
        kind: "push_notification",
        userId: target.user_id,
        deviceId: target.device_id,
        token: "apns-device-token",
        aggregate: null,
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env",
          threadId: "thread",
          deepLink: "/",
        },
        createdAt,
        expiresAt,
        jobId: "job-push-in-flight",
      });
      return Effect.gen(function* () {
        const body = yield* signApnsDeliveryJob({
          secret: config.apnsDeliveryJobSigningSecret,
          payload,
        });
        const message: Cloudflare.Queues.Message<unknown> = {
          id: job,
          body,
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(createdAt)),
          attempts: 1,
          ack: () => outcomes.push("ack"),
          retry: () => outcomes.push("retry"),
        };
        yield* ApnsDeliveryQueueConsumer.processMessage(message);
      }).pipe(
        Effect.andThen(Effect.sync(() => expect(outcomes).toEqual([outcome]))),
        Effect.provide(
          layerFor({
            attempts: [],
            sourceJobClaims: new Map([["job-push-in-flight", "in_flight"]]),
            config: signingConfig,
          }),
        ),
      );
    },
  );

  it.effect("invalidates dead device push tokens after permanent APNs alert failures", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Failed: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-bad-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "BadDeviceToken" }, { status: 400 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(yield* signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(400);
      expect(result.apnsReason).toBe("BadDeviceToken");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "push_notification",
        },
      ]);
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          invalidatedTokens,
          currentTargets: [
            {
              ...target,
              push_token: "apns-device-token",
            },
          ],
          config: signingConfig,
          activityStates: [{ ...state, phase: "failed" }],
          execute,
        }),
      ),
    );
  });

  it.effect("invalidates dead Live Activity tokens after APNs unregisters them", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.activity_push_token ?? "activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-unregistered",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "Unregistered" }, { status: 410 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(yield* signed);

      expect(result.kind).toBe("live_activity_update");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(410);
      expect(result.apnsReason).toBe("Unregistered");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "live_activity_update",
        },
      ]);
    }).pipe(
      Effect.provide(layerFor({ attempts, invalidatedTokens, config: signingConfig, execute })),
    );
  });
});

it.effect("keeps a queued completion identity when a restarted server mutes it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pg = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (client) => Effect.promise(() => client.close()),
    );
    const migration = yield* fs.readFileString(
      new URL("../../migrations/postgres/20260527044716_baseline/migration.sql", import.meta.url)
        .pathname,
    );
    const environmentPublicKey = "env-key";
    yield* Effect.promise(() => pg.exec(migration));
    yield* Effect.promise(() =>
      pg.query(
        `insert into relay_environment_links
        (user_id, environment_id, environment_public_key, endpoint_http_base_url,
         endpoint_ws_base_url, endpoint_provider_kind, created_at, updated_at)
       values ($1, $2, $3, 'http://localhost', 'ws://localhost', 'manual', $4, $4)`,
        [target.user_id, state.environmentId, environmentPublicKey, state.updatedAt],
      ),
    );

    const db = yield* makeWithDefaults().pipe(
      Effect.provideService(PgClient, {
        // PGlite has one connection, so statements already run one at a time.
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        unsafe: (statement: string, params?: ReadonlyArray<unknown>) => {
          const objects = Effect.promise(
            async () => (await pg.query(statement, [...(params ?? [])])).rows,
          );
          return Object.assign(objects, {
            raw: objects,
            withoutTransform: objects,
            values: Effect.promise(
              async () =>
                (await pg.query(statement, [...(params ?? [])], { rowMode: "array" })).rows,
            ),
          });
        },
      } as unknown as PgClient),
    );
    const rows = yield* AgentActivityRows.AgentActivityRows.pipe(
      Effect.provide(
        AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
      ),
    );
    const completed = { ...state, phase: "completed" } satisfies RelayAgentActivityState;
    const device = { ...target, push_token: "apns-device-token", activity_push_token: null };
    const job = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload: makeApnsDeliveryJobPayload({
        kind: "push_notification",
        userId: device.user_id,
        deviceId: device.device_id,
        token: device.push_token,
        aggregate: null,
        notification: {
          title: completed.threadTitle,
          body: "Done: Project",
          environmentId: completed.environmentId,
          threadId: completed.threadId,
          deepLink: completed.deepLink,
          phase: completed.phase,
          updatedAt: completed.updatedAt,
        },
        createdAt: state.updatedAt,
        expiresAt: "1970-01-01T00:10:00.000Z",
        jobId: "completion-before-restart",
      }),
    });
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    yield* Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      expect(yield* rows.upsert({ environmentPublicKey, state: completed })).toBeNull();
      const mute = {
        ...completed,
        silent: true,
        notificationLevel: "muted",
        updatedAt: "1970-01-01T00:00:01.000Z",
      } satisfies RelayAgentActivityState;
      yield* rows.upsert({ environmentPublicKey, state: mute });
      yield* rows.upsert({
        environmentPublicKey,
        state: { ...mute, threadId: ThreadId.make("no-row") },
      });
      expect(yield* rows.listForUser({ userId: device.user_id })).toEqual([
        { ...completed, notificationLevel: "muted" },
      ]);
      const result = yield* deliveries.processSignedJob(yield* job);
      expect(result.apnsStatus).toBeNull();
      expect(requests).toHaveLength(0);
      const occurred = { ...completed, occurredAt: "1970-01-01T00:00:02.000Z" };
      const renamed = {
        ...occurred,
        threadTitle: "Renamed",
        updatedAt: "1970-01-01T00:00:03.000Z",
      };
      const previousOccurrence = (alertUnsent: boolean) => ({
        phase: "completed",
        occurredAt: occurred.occurredAt,
        alertUnsent,
      });
      expect(yield* rows.upsert({ environmentPublicKey, state: occurred })).toEqual({
        phase: "completed",
        occurredAt: null,
        alertUnsent: false,
      });
      expect(yield* rows.upsert({ environmentPublicKey, state: renamed })).toEqual(
        previousOccurrence(false),
      );
      // A publish that failed only marks the state it wrote, never a newer one.
      yield* rows.markAlertUnsent({ environmentPublicKey, state: occurred });
      expect(yield* rows.upsert({ environmentPublicKey, state: renamed })).toEqual(
        previousOccurrence(false),
      );
      yield* rows.markAlertUnsent({ environmentPublicKey, state: renamed });
      expect((yield* rows.listForUser({ userId: device.user_id }))[0]).not.toHaveProperty(
        "alertUnsent",
      );
      expect(yield* rows.upsert({ environmentPublicKey, state: renamed })).toEqual(
        previousOccurrence(true),
      );
      expect(yield* rows.upsert({ environmentPublicKey, state: renamed })).toEqual(
        previousOccurrence(false),
      );
    }).pipe(
      Effect.provide(
        layerFor({
          attempts: [],
          activityRows: rows,
          config: signingConfig,
          currentTargets: [device],
          execute: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("fast completion delivery", () => {
  it.effect.each([
    { otherCount: 1, notificationsAllowed: true, retry: false },
    { otherCount: 5, notificationsAllowed: true, retry: false },
    { otherCount: 1, notificationsAllowed: true, retry: true },
    { otherCount: 1, notificationsAllowed: false, retry: false },
  ])(
    "delivers the triggering completion with $otherCount other rows (link alerts: $notificationsAllowed, retry: $retry)",
    ({ otherCount, notificationsAllowed, retry }) => {
      let failAggregateLookup = retry;
      const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
      const markedDeliveries: Array<
        Parameters<LiveActivities.LiveActivities["Service"]["markDelivery"]>[0]
      > = [];
      const queuedJobs: SignedApnsDeliveryJob[] = [];
      const running = Array.from({ length: otherCount }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const done = {
        ...state,
        phase: "completed",
        notificationLevel: "following",
      } satisfies RelayAgentActivityState;
      const states = [...running, done];
      const previous = makeAggregateState({ activeStates: running, terminalState: null, nowMs: 0 });
      const next = makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 });
      const device = {
        ...target,
        push_token: "apns-device-token",
        last_aggregate_json: JSON.stringify(previous),
      };
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        yield* deliveries.sendForTarget({
          target: device,
          aggregate: next,
          nowMs: 0,
          trigger: done,
        });
        expect(queuedJobs).toHaveLength(1);
        if (retry) {
          const unavailable = yield* Effect.exit(deliveries.processSignedJob(queuedJobs[0]!));
          expect(unavailable._tag).toBe("Failure");
          expect(attempts).toHaveLength(0);
          expect(markedDeliveries).toHaveLength(0);
          expect(requests).toHaveLength(0);
        }
        yield* deliveries.processSignedJob(queuedJobs[0]!);
        expect(markedDeliveries).toHaveLength(1);
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag === "Uint8Array") {
          const { aps } = JSON.parse(new TextDecoder().decode(request.body.body));
          expect(aps.event).toBe("update");
          expect(aps.alert?.title).toBe(notificationsAllowed ? done.threadTitle : undefined);
        }
      }).pipe(
        Effect.provide(
          layerFor({
            attempts,
            markedDeliveries,
            failAggregateLookup: () => {
              const fail = failAggregateLookup;
              failAggregateLookup = false;
              return fail;
            },
            queuedJobs,
            config: signingConfig,
            activityStates: states,
            currentTargets: [device],
            notificationsAllowed,
            execute: (request) =>
              Effect.sync(() => {
                requests.push(request);
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    },
  );
  it.effect.each([false, true])(
    "alerts a newly visible completion only outside a replay (replay: %s)",
    (replay) => {
      const queuedJobs: SignedApnsDeliveryJob[] = [];
      const completed = {
        ...state,
        phase: "completed",
        occurredAt: state.updatedAt,
      } satisfies RelayAgentActivityState;
      const done = {
        ...aggregate,
        activeCount: 0,
        activities: [{ ...aggregate.activities[0]!, phase: "completed" as const }],
      };
      const previous = {
        ...aggregate,
        activities: [
          { ...aggregate.activities[0]!, threadId: "other" as RelayAgentActivityState["threadId"] },
        ],
      };
      const device = {
        ...target,
        push_token: "apns-device-token",
        last_aggregate_json: JSON.stringify(previous),
      };
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        yield* deliveries.sendForTarget({
          target: device,
          aggregate: done,
          nowMs: 0,
          replay,
          trigger: completed,
        });
        expect(queuedJobs).toHaveLength(1);
        expect(queuedJobs[0]?.payload.alert?.title).toBe(
          replay ? undefined : completed.threadTitle,
        );
      }).pipe(Effect.provide(layerFor({ attempts: [], queuedJobs })));
    },
  );

  it.effect("sends a queued card alert as one push after Live Activities turn off", () => {
    const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
    const queuedJobs: SignedApnsDeliveryJob[] = [];
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const done = {
      ...state,
      phase: "completed",
      occurredAt: state.updatedAt,
    } satisfies RelayAgentActivityState;
    const device = { ...target, push_token: "apns-device-token" };
    const currentTargets = [device];
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: device,
        aggregate: makeAggregateState({ activeStates: [done], terminalState: null, nowMs: 0 }),
        nowMs: 0,
        trigger: done,
      });
      expect(queuedJobs.map((job) => job.payload.kind)).toEqual(["live_activity_update"]);
      const card = queuedJobs[0]!;
      currentTargets[0] = { ...device, preferences_json: disabledPreferences };
      yield* deliveries.processSignedJob(card);
      expect(queuedJobs.map((job) => job.payload.jobId)).toEqual([
        card.payload.jobId,
        `${card.payload.jobId}:push`,
      ]);
      yield* deliveries.processSignedJob(queuedJobs[1]!);
      const alerts = requests.flatMap((request) => {
        if (request.body._tag !== "Uint8Array") return [];
        const { aps } = JSON.parse(new TextDecoder().decode(request.body.body));
        return aps.alert ? [{ topic: request.headers["apns-topic"], title: aps.alert.title }] : [];
      });
      expect(alerts).toEqual([{ topic: "com.t3tools.t3code.dev", title: done.threadTitle }]);
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          queuedJobs,
          config: signingConfig,
          activityStates: [done],
          currentTargets,
          execute: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });
});

describe("signed APNs registration metadata", () => {
  it.effect.each(
    (["live_activity_update", "push_notification"] as const).flatMap((kind) =>
      (["bundle", "environment", "legacy"] as const).map((changed) => ({ kind, changed })),
    ),
  )("routes $kind using current registration with $changed job metadata", ({ kind, changed }) => {
    const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const payload = makeApnsDeliveryJobPayload({
      kind,
      userId: target.user_id,
      deviceId: target.device_id,
      token: "unchanged-token",
      ...(changed === "legacy"
        ? {}
        : { bundleId: "com.t3tools.t3code.dev", apsEnvironment: "sandbox" as const }),
      aggregate: kind === "live_activity_update" ? aggregate : null,
      ...(kind === "push_notification"
        ? {
            notification: {
              title: "Thread",
              body: "Input: Project",
              environmentId: "env",
              threadId: "thread",
              deepLink: "/",
            },
          }
        : {}),
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: `metadata-${kind}-${changed}`,
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(yield* signed);
      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        `${changed === "environment" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com"}/3/device/unchanged-token`,
      );
      expect(requests[0]?.headers["apns-topic"]).toBe(
        `${changed === "bundle" ? "com.t3tools.t3code.preview" : "com.t3tools.t3code.dev"}${kind === "live_activity_update" ? ".push-type.liveactivity" : ""}`,
      );
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          config: signingConfig,
          activityStates:
            kind === "push_notification" ? [{ ...state, phase: "waiting_for_input" }] : [state],
          currentTargets: [
            {
              ...target,
              push_token: "unchanged-token",
              activity_push_token: "unchanged-token",
              bundle_id:
                changed === "bundle" ? "com.t3tools.t3code.preview" : "com.t3tools.t3code.dev",
              aps_environment: changed === "environment" ? "production" : "sandbox",
            },
          ],
          execute: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });
});
