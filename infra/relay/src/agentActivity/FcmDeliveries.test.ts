import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as FcmDeliveryQueueConsumer from "./FcmDeliveryQueueConsumer.ts";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as FcmDeliveryQueueSender from "./FcmDeliveryQueueSender.ts";
import * as FcmClient from "./FcmClient.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import { androidActivityData, androidAlertForState, fitFcmData } from "./fcmPayloads.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";

const aggregateFor = (states: ReadonlyArray<RelayAgentActivityState>) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Fix notifications",
  phase: "running",
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const target: LiveActivities.TargetRow = {
  user_id: "user",
  device_id: "phone",
  platform: "android",
  ios_major_version: null,
  app_version: null,
  bundle_id: "com.t3tools.t3code.dev",
  aps_environment: null,
  push_token: "fcm-token",
  push_to_start_token: null,
  preferences_json: encodeJson(preferences),
  activity_push_token: null,
  remote_start_queued_at: null,
  remote_started_at: null,
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};
const config = {
  relayIssuer: "https://relay.test",
  fcmServiceAccount: Redacted.make("configured"),
  apns: {
    environment: "sandbox",
    teamId: "unused",
    keyId: "unused",
    bundleId: "unused",
    privateKey: Redacted.make("unused"),
  },
  clerkSecretKey: Redacted.make("unused"),
  clerkPublishableKey: "unused",
  clerkJwtAudience: "unused",
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
} satisfies RelayConfiguration.RelayConfiguration["Service"];

function harness() {
  const sent: Array<Parameters<FcmClient.FcmClient["Service"]["send"]>[0]> = [];
  const queued: FcmDeliveries.FcmDeliveryJob[] = [];
  const marked: Array<Parameters<LiveActivities.LiveActivities["Service"]["markDelivery"]>[0]> = [];
  const current = {
    target: { ...target },
    state: { ...state } as RelayAgentActivityState | null,
    otherStates: [] as RelayAgentActivityState[],
    mutedEnvironments: [] as string[],
    notificationOnlyEnvironments: [] as string[],
    revokedEnvironments: [] as string[],
    linked: true,
    deliveryFailure: null as FcmClient.FcmClientError | null,
  };
  const layerServices = Layer.mergeAll(
    NodeCryptoLayer.layer,
    Layer.succeed(RelayConfiguration.RelayConfiguration, config),
    Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
      send: (job) =>
        Effect.sync(() => {
          queued.push(job);
        }),
    }),
    Layer.succeed(FcmClient.FcmClient, {
      send: (input) =>
        Effect.suspend(() =>
          current.deliveryFailure
            ? Effect.fail(current.deliveryFailure)
            : Effect.sync(() => {
                sent.push(input);
                return { unregistered: false };
              }),
        ),
    }),
    Layer.succeed(LiveActivities.LiveActivities, {
      register: () => Effect.void,
      listTargets: () => Effect.sync(() => [current.target]),
      listIdleArmedTargets: () => Effect.succeed([]),
      markDelivery: (input) =>
        Effect.sync(() => {
          marked.push(input);
          current.target.last_aggregate_json = input.aggregate ? encodeJson(input.aggregate) : null;
        }),

      invalidateDeliveryToken: () => Effect.void,
    }),
    Layer.succeed(AgentActivityRows.AgentActivityRows, {
      upsert: () => Effect.succeed(null),
      remove: () => Effect.void,
      pruneTerminal: () => Effect.void,
      markAlertUnsent: () => Effect.void,
      listForUser: () =>
        Effect.sync(() =>
          current.linked
            ? [...(current.state ? [current.state] : []), ...current.otherStates].filter(
                (row) =>
                  !current.revokedEnvironments.includes(row.environmentId) &&
                  !current.notificationOnlyEnvironments.includes(row.environmentId),
              )
            : [],
        ),
      getForUserThread: (input) =>
        Effect.sync(() =>
          current.linked
            ? ([current.state, ...current.otherStates].find(
                (row) =>
                  row?.environmentId === input.environmentId && row.threadId === input.threadId,
              ) ?? null)
            : null,
        ),
    }),
    Layer.succeed(EnvironmentLinks.EnvironmentLinks, {
      upsert: () => Effect.succeed(null),
      listDeliveryUsersForEnvironment: (input) =>
        Effect.sync(() =>
          current.linked && !current.revokedEnvironments.includes(input.environmentId)
            ? [
                {
                  userId: "user",
                  notificationsEnabled: !current.mutedEnvironments.includes(input.environmentId),
                  liveActivitiesEnabled: !current.notificationOnlyEnvironments.includes(
                    input.environmentId,
                  ),
                },
              ]
            : [],
        ),
      listForUser: () => Effect.succeed([]),
      findActiveManagedForEnvironment: () => Effect.succeed([]),
      setHoldWebhooksWhileOffline: () => Effect.void,
      revokeForUser: () => Effect.succeed(false),
      getForUser: (input) =>
        Effect.sync(() =>
          current.linked && !current.revokedEnvironments.includes(input.environmentId)
            ? {
                environmentId: EnvironmentId.make(input.environmentId),
                label: "Desktop",
                environmentPublicKey: "key",
                linkedAt: state.updatedAt,
                endpoint: {
                  httpBaseUrl: "https://env.test",
                  wsBaseUrl: "wss://env.test",
                  providerKind: "manual",
                },
              }
            : null,
        ),
    }),
    Layer.succeed(RelayDb.RelayDb, {} as RelayDb.RelayDb["Service"]),
  );
  return {
    sent,
    queued,
    marked,
    current,
    layer: FcmDeliveries.layer.pipe(Layer.provide(layerServices)),
    job: {
      userId: "user",
      deviceId: "phone",
      token: "fcm-token",
      state,
      queuedAt: 0,
    } satisfies FcmDeliveries.FcmDeliveryJob,
  };
}

describe("Android delivery routing", () => {
  const secondState: RelayAgentActivityState = {
    ...state,
    threadId: ThreadId.make("second-thread"),
    threadTitle: "Second thread",
    deepLink: "/threads/env/second-thread",
  };

  it.effect("alerts a followed completion and another thread's input request together", () => {
    const h = harness();
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([state, secondState]));
    h.current.target.preferences_json = encodeJson({ ...preferences, notifyOnCompletion: false });
    h.current.state = { ...state, phase: "completed", notificationLevel: "following" };
    h.current.otherStates = [{ ...secondState, phase: "waiting_for_input" }];
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
      yield* delivery.process({ ...h.job, state: h.current.otherStates[0], trigger: true });
      expect(h.sent.filter((message) => message.alert).map((message) => message.data)).toEqual([
        expect.objectContaining({ alert_title: "Fix notifications", alert_body: "Done: Project" }),
        expect.objectContaining({ alert_title: "Second thread", alert_body: "Input: Project" }),
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does not alert a stale completion trigger", () => {
    const h = harness();
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([state]));
    h.current.state = { ...state, phase: "completed", updatedAt: "1969-12-31T23:57:00.000Z" };
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
      expect(h.sent.every((message) => !message.alert)).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each(["completed", "waiting_for_approval", "waiting_for_input", "failed"] as const)(
    "deleting one thread preserves another thread's %s alert",
    (phase) => {
      const h = harness();
      h.current.otherStates = [secondState];
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries.FcmDeliveries;
        yield* delivery.process(h.job);
        h.current.otherStates = [];
        h.current.state = { ...state, phase };
        yield* delivery.enqueue({ target, state: null });
        yield* delivery.process(h.queued[0]);
        expect(h.sent.at(-1)?.alert).toBe(false);
        yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
        expect(h.sent.filter((message) => message.alert)).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("registration replay establishes a baseline without alerting", () => {
    const h = harness();
    h.current.state = { ...state, phase: "waiting_for_approval" };
    h.current.otherStates = [{ ...secondState, phase: "waiting_for_input" }];
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.enqueue({ target, state: null, replay: true });
      yield* delivery.process(h.queued[0]);
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent.every((message) => !message.alert)).toBe(true);
      expect(h.marked[0]?.aggregate?.activities).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each(["mutedEnvironments", "revokedEnvironments"] as const)(
    "does not alert a trigger from %s",
    (restriction) => {
      const h = harness();
      const other = { ...secondState, environmentId: EnvironmentId.make("other-env") };
      h.current.target.last_aggregate_json = encodeJson(aggregateFor([state, other]));
      h.current.otherStates = [{ ...other, phase: "waiting_for_input" }];
      h.current[restriction] = [other.environmentId];
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries.FcmDeliveries;
        yield* delivery.process({ ...h.job, state: h.current.otherStates[0], trigger: true });
        expect(h.sent.every((message) => !message.alert)).toBe(true);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it("keeps an alert's identity through a rename and changes it for a new occurrence", () => {
    const completed = {
      ...state,
      phase: "completed" as const,
      occurredAt: "1970-01-01T00:00:00.000Z",
    };
    const identity = (next: RelayAgentActivityState) =>
      androidAlertForState(next, preferences, 0)?.alert_id;
    expect(
      identity({ ...completed, threadTitle: "Renamed", updatedAt: "1970-01-01T00:00:01.000Z" }),
    ).toBe(identity(completed));
    expect(identity({ ...completed, occurredAt: "1970-01-01T00:00:01.000Z" })).not.toBe(
      identity(completed),
    );
  });

  it("keeps notification groups distinct when identifiers contain slashes", () => {
    const left = androidAlertForState(
      {
        ...state,
        environmentId: EnvironmentId.make("a/b"),
        threadId: ThreadId.make("c"),
        phase: "completed",
      },
      preferences,
      0,
    );
    const right = androidAlertForState(
      {
        ...state,
        environmentId: EnvironmentId.make("a"),
        threadId: ThreadId.make("b/c"),
        phase: "completed",
      },
      preferences,
      0,
    );
    expect(left?.alert_group).not.toBe(right?.alert_group);
  });

  it.effect(
    "queues Android devices and sends the latest aggregate instead of a stale running state",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries.FcmDeliveries;
        yield* delivery.enqueue({ target, state });
        h.current.state = { ...state, phase: "completed" };
        yield* delivery.process(h.queued[0]);
        expect(h.sent).toHaveLength(0);
        yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
        expect(h.sent[0]?.data).toMatchObject({
          active: "false",
          alert_title: "Fix notifications",
          alert_body: "Done: Project",
          alert_path: "/threads/env/thread",
        });
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("keeps completion alerts working with ongoing activity disabled and a rename", () => {
    const h = harness();
    const completed = {
      ...state,
      phase: "completed",
      occurredAt: state.updatedAt,
    } satisfies RelayAgentActivityState;
    h.current.state = {
      ...completed,
      threadTitle: "Renamed",
      updatedAt: "1970-01-01T00:00:01.000Z",
    };
    h.current.target.preferences_json = encodeJson({
      ...preferences,
      liveActivitiesEnabled: false,
    });
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.process({ ...h.job, state: completed, trigger: true });
      expect(h.sent[0]?.data).toMatchObject({
        active: "false",
        alert_title: "Renamed",
        alert_body: "Done: Project",
      });
      expect(h.sent[0]?.data.user_id).toBe("user");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("drops jobs for rotated tokens, expired jobs, and revoked links", () => {
    const h = harness();
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.process({ ...h.job, token: "old-token" });
      yield* delivery.process({ ...h.job, queuedAt: -400_000 });
      h.current.linked = false;
      yield* delivery.process(h.job);
      expect(h.sent).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("ends an existing ongoing notification when the environment stops publishing", () => {
    const h = harness();
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([state]));
    h.current.state = null;
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.process({ ...h.job, state: null });
      expect(h.sent[0]?.data).toMatchObject({ active: "false" });
      expect(h.sent[0]?.alert).toBe(false);
      expect(h.marked[0]?.kind).toBe("live_activity_end");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("leaves iOS devices on their existing delivery path", () => {
    const h = harness();
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      expect(yield* delivery.enqueue({ target: { ...target, platform: "ios" }, state })).toBeNull();
      expect(h.queued).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("honors disabled alert preferences while continuing ongoing activity", () => {
    const h = harness();
    h.current.state = { ...state, phase: "waiting_for_approval" };
    h.current.target.preferences_json = encodeJson({ ...preferences, notificationsEnabled: false });
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
      expect(h.sent[0]?.data.active).toBe("true");
      expect(h.sent[0]?.data.alert_id).toBeUndefined();
      h.current.target.preferences_json = encodeJson({ ...preferences, notifyOnApproval: false });
      yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
      expect(h.sent[1]?.data.active).toBe("true");
      expect(h.sent[1]?.data.alert_id).toBeUndefined();
      h.current.state = { ...h.current.state!, notificationLevel: "following" };
      h.current.target.last_aggregate_json = encodeJson(aggregateFor([state]));
      yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
      expect(h.sent[2]?.data.alert_title).toBe(state.threadTitle);
      h.current.target.preferences_json = encodeJson({
        ...preferences,
        notificationsEnabled: false,
      });
      h.current.target.last_aggregate_json = encodeJson(aggregateFor([state]));
      yield* delivery.process({ ...h.job, state: h.current.state, trigger: true });
      expect(h.sent[3]?.data.active).toBe("true");
      expect(h.sent[3]?.data.alert_id).toBeUndefined();
      expect(h.marked.at(-1)?.kind).toBe("live_activity_update");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("replays an empty card to repair an orphan without a delivery baseline", () => {
    const h = harness();
    h.current.state = null;
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries.FcmDeliveries;
      yield* delivery.process({ ...h.job, state: null });
      expect(h.sent[0]?.data.activity_expires_at).toBe("0");
      expect(h.sent[0]?.alert).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it("fits five Unicode rows and an alert in the FCM budget without corrupting text or routes", () => {
    const longTitle = '🤖漢字"\\'.repeat(30);
    const aggregate = aggregateFor(
      Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`thread-${i}`),
        threadTitle: longTitle,
        projectTitle: longTitle,
      })),
    );
    const data = fitFcmData({
      ...androidActivityData(aggregate),
      t3_kind: "agent_activity",
      device_id: "d".repeat(128),
      user_id: "u".repeat(128),
      updated_at: "1788780000000",
      alert_id: "a".repeat(64),
      alert_title: "5 agents finished",
      alert_body: Array(5).fill(longTitle).join(", "),
      alert_path: "/threads/env/thread",
    });
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(3800);
    expect(data.alert_path).toBe("/threads/env/thread");
    expect(data.activity_path).toBe("/threads/env/thread");
    expect(data.alert_id).toBe("a".repeat(64));
    expect(data.activity_line_4).toContain("Working\t");
    for (const value of Object.values(data))
      expect(new TextDecoder().decode(new TextEncoder().encode(value))).toBe(value);
  });
});

describe("delivery policy regressions", () => {
  it.effect.each([1, 5])("alerts a followed completion with %s other card rows", (count) => {
    const h = harness();
    const other = Array.from({ length: count }, (_, i) => ({
      ...state,
      threadId: ThreadId.make(`other-${i}`),
    }));
    h.current.target.last_aggregate_json = encodeJson(aggregateFor(other));
    h.current.target.preferences_json = encodeJson({ ...preferences, notifyOnCompletion: false });
    h.current.otherStates = other;
    h.current.state = { ...state, phase: "completed", notificationLevel: "following" };
    return Effect.gen(function* () {
      const d = yield* FcmDeliveries.FcmDeliveries;
      yield* d.process({ ...h.job, state: h.current.state, trigger: true });
      const alerts = h.sent.filter((message) => message.alert);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.data.alert_title).toBe(state.threadTitle);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("keeps an older waiting thread visible and alertable beyond five running rows", () => {
    const h = harness();
    const running = Array.from({ length: 5 }, (_, i) => ({
      ...state,
      threadId: ThreadId.make(`running-${i}`),
    }));
    h.current.target.last_aggregate_json = encodeJson(aggregateFor(running));
    h.current.otherStates = running;
    h.current.state = {
      ...state,
      phase: "waiting_for_approval",
      updatedAt: "1969-12-31T23:59:00.000Z",
    };
    return Effect.gen(function* () {
      const d = yield* FcmDeliveries.FcmDeliveries;
      yield* d.process({ ...h.job, state: h.current.state, trigger: true });
      expect(h.sent[0]?.alert).toBe(true);
      expect(h.sent[0]?.data.activity_phase).toBe("waiting_for_approval");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("notification-only environments", () => {
  it.effect("alerts independently while another environment has a live card", () => {
    const h = harness();
    const other = {
      ...state,
      environmentId: EnvironmentId.make("other"),
      threadId: ThreadId.make("other"),
    };
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([other]));
    h.current.otherStates = [other];
    h.current.state = { ...state, phase: "waiting_for_input" };
    h.current.notificationOnlyEnvironments = [state.environmentId];
    return Effect.gen(function* () {
      const deliveries = yield* FcmDeliveries.FcmDeliveries;
      yield* deliveries.process({ ...h.job, state: h.current.state, trigger: true });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.alert).toBe(true);
      expect(h.sent[0]?.data.alert_path).toBe(state.deepLink);
    }).pipe(Effect.provide(h.layer));
  });
});

it("stops reducing five-character row fields and fits the remaining alert", () => {
  const data = fitFcmData({
    device_id: "x".repeat(3710),
    activity_line_0: "Approval\taaaaa\tbbbbb",
    alert_body: "y".repeat(200),
  });
  expect(data.activity_line_0).toBe("Approval\taaaaa\tbbbbb");
  expect(new TextEncoder().encode(encodeJson(data)).length).toBeLessThanOrEqual(3800);
});

describe("FCM queue message isolation", () => {
  it.effect.each([
    { failure: "invalid-job", outcome: "ack" },
    { failure: "fcm-rejection", outcome: "retry" },
  ] as const)(
    "settles the $failure message with $outcome and delivers the rest of its batch",
    ({ failure, outcome }) => {
      const h = harness();
      const outcomes = new Map<string, "ack" | "retry">();
      const message = (id: string, body: unknown): Cloudflare.Queues.Message<unknown> => ({
        id,
        body,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        attempts: 1,
        ack: () => {
          if (!outcomes.has(id)) outcomes.set(id, "ack");
        },
        retry: () => {
          if (!outcomes.has(id)) outcomes.set(id, "retry");
        },
      });
      const batch = [
        message("failed", failure === "invalid-job" ? {} : h.job),
        message("healthy", h.job),
      ];
      return Effect.gen(function* () {
        yield* Stream.fromIterable(batch).pipe(
          Stream.tap((item) =>
            Effect.sync(() => {
              h.current.deliveryFailure =
                item.id === "failed" && failure === "fcm-rejection"
                  ? new FcmClient.FcmClientError({ operation: "send", status: 400 })
                  : null;
            }),
          ),
          Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
        );
        // Cloudflare ignores Alchemy's final batch acknowledgements for already-retried messages.
        for (const item of batch) item.ack();
        expect([...outcomes]).toEqual([
          ["failed", outcome],
          ["healthy", "ack"],
        ]);
        expect(h.sent).toHaveLength(1);
        expect(h.marked).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
});
