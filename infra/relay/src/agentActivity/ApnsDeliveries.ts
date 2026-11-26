import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
  RelayDeliveryKind,
  RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import {
  RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema,
  RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema,
  RelayDeliveryKind as RelayDeliveryKindSchema,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  isExpiredAgentActivityState,
  notificationForActivity,
  sanitizeAgentActivityAggregateState,
  sanitizeApnsNotificationPayload,
} from "./agentActivityPayloads.ts";
import { aggregateRowForState, makeAggregateState } from "./agentActivityAggregate.ts";
import * as Apns from "./ApnsClient.ts";
import {
  ApnsDeliveryJobLiveActivityAggregateMissing,
  ApnsDeliveryJobPushNotificationMissing,
  ApnsDeliveryJobQueuePayloadInvalid,
  type ApnsLiveActivityAlert,
  type ApnsNotificationPayload,
  SignedApnsDeliveryJob,
  verifySignedApnsDeliveryJob,
  type ApnsDeliveryJobVerificationError,
} from "./apnsDeliveryJobs.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import { withSpanAttributes } from "../observability.ts";

import {
  isSameOccurrence,
  rowPhasesChanged,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";
const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const FRESHLY_ARMED_GRACE_MS = 2 * 60 * 1_000;
const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

type LiveActivityDeliveryKind = Extract<
  RelayDeliveryKind,
  "live_activity_update" | "live_activity_end"
>;

type ChosenLiveActivityDelivery =
  | {
      readonly kind: "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    };

export type ApnsDeliveryError =
  | ApnsDeliveryQueue.ApnsDeliveryQueueError
  | ApnsDeliveryJobVerificationError
  | ApnsDeliveryJobClaimInFlight
  | DeliveryAttempts.DeliveryAttemptRecordPersistenceError
  | AgentActivityRows.AgentActivityRowListPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | LiveActivities.LiveActivityDeliveryMarkPersistenceError;

export class ApnsDeliveryJobClaimInFlight extends Schema.TaggedError<ApnsDeliveryJobClaimInFlight>()(
  "ApnsDeliveryJobClaimInFlight",
  {
    sourceJobId: Schema.String,
  },
) {
  override get message(): string {
    return `APNs delivery job '${this.sourceJobId}' is already in flight`;
  }
}

export class ApnsDeliveryTransportError extends Schema.TaggedError<ApnsDeliveryTransportError>()(
  "ApnsDeliveryTransportError",
  {
    deviceId: Schema.String,
    kind: RelayDeliveryKindSchema,
    sourceJobId: Schema.NullOr(Schema.String),
    apnsErrorTag: Schema.Literals([
      "ApnsJwtEncodingError",
      "ApnsJwtSigningError",
      "ApnsHttpRequestError",
    ]),
    requestStage: Schema.NullOr(Schema.Literals(["send", "read-response"])),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs ${this.kind} delivery failed for device ${this.deviceId}.`;
  }
}

const decodeRelayAgentActivityAggregateStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);
const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);
const decodeSignedApnsDeliveryJob = Schema.decodeUnknownEffect(SignedApnsDeliveryJob);

function parseAggregate(value: string | null): RelayAgentActivityAggregateState | null {
  if (!value) {
    return null;
  }
  return Option.getOrNull(decodeRelayAgentActivityAggregateStateJson(value));
}

function parsePreferences(value: string): RelayAgentAwarenessPreferences | null {
  return Option.getOrNull(decodeRelayAgentAwarenessPreferencesJson(value));
}

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (aggregateNeedsAttention(input.nextAggregate)) {
    return true;
  }
  // Phase and row changes may be the last update until the next transition.
  // Throttling them would leave the card showing a stale state indefinitely.
  if (rowPhasesChanged(input.previousAggregate, input.nextAggregate)) {
    return true;
  }
  const lastDeliveryAtMs =
    input.lastDeliveryAt === null
      ? null
      : Option.match(DateTime.make(input.lastDeliveryAt), {
          onNone: () => Number.NaN,
          onSome: (dt) => dt.epochMilliseconds,
        });
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

function notificationForState(state: RelayAgentActivityState): ApnsNotificationPayload {
  return {
    ...notificationForActivity(aggregateRowForState(state)),
    ...(state.occurredAt === undefined ? {} : { occurredAt: state.occurredAt }),
  };
}

function notificationForTrigger(input: {
  readonly target: LiveActivities.TargetRow;
  readonly trigger?: RelayAgentActivityState | null;
  readonly nowMs: number;
}) {
  const { trigger } = input;
  if (!trigger || isExpiredAgentActivityState(trigger, input.nowMs)) {
    return null;
  }
  const preferences = parsePreferences(input.target.preferences_json);
  if (!shouldAlertForActivity({ ...trigger, preferences, nowMs: input.nowMs })) return null;
  return notificationForState(trigger);
}

function chooseLiveActivityDelivery(input: {
  readonly target: LiveActivities.TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
  readonly hasAlert: boolean;
}): ChosenLiveActivityDelivery | "suppressed" | null {
  if (!input.target.activity_push_token) return null;
  const token = input.target.activity_push_token;
  const preferences = parsePreferences(input.target.preferences_json);
  if (preferences?.liveActivitiesEnabled === false) {
    return { kind: "live_activity_end", token, aggregate: null };
  }
  if (input.aggregate === null) {
    // Registration replay can precede the first publish; keep a freshly armed card until state arrives.
    const armedAt =
      input.target.remote_started_at === null
        ? null
        : Option.getOrNull(DateTime.make(input.target.remote_started_at));
    if (armedAt && input.nowMs - armedAt.epochMilliseconds < FRESHLY_ARMED_GRACE_MS) return null;
    return { kind: "live_activity_end", token, aggregate: null };
  }
  if (
    !input.hasAlert &&
    !shouldUpdateLiveActivity({
      previousAggregate: parseAggregate(input.target.last_aggregate_json),
      nextAggregate: input.aggregate,
      lastDeliveryAt: input.target.last_live_activity_delivery_at,
      nowMs: input.nowMs,
    })
  )
    return "suppressed";
  return { kind: "live_activity_update", token, aggregate: input.aggregate };
}

function deliveryEvent(kind: LiveActivityDeliveryKind): Apns.ApnsLiveActivityEvent {
  switch (kind) {
    case "live_activity_update":
      return "update";
    case "live_activity_end":
      return "end";
  }
}

function isPermanentApnsTokenFailure(result: Apns.ApnsDeliveryResult): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

function duplicateJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Duplicate APNs delivery job skipped.",
    apnsId: null,
  };
}

function staleJobResult(input: {
  readonly deviceId: string;
  readonly kind: RelayDeliveryKind;
}): RelayDeliveryResult {
  return {
    deviceId: input.deviceId,
    kind: input.kind,
    ok: true,
    apnsStatus: null,
    apnsReason: "Stale APNs delivery job skipped.",
    apnsId: null,
  };
}

function deliveryAttemptOutcome(result: Apns.ApnsDeliveryResult) {
  return {
    ...(result.status === 0 ? {} : { apnsStatus: result.status }),
    ...(result.reason === undefined ? {} : { apnsReason: result.reason }),
    apnsId: result.apnsId,
    ...(result.status === 0 ? { transportError: result.reason ?? "APNs request failed." } : {}),
  };
}

const recoverApnsDeliveryTransportError = (
  input: {
    readonly deviceId: string;
    readonly kind: RelayDeliveryKind;
    readonly sourceJobId: string | null;
  },
  cause: Apns.ApnsError,
): Effect.Effect<Apns.ApnsDeliveryResult> => {
  const error = new ApnsDeliveryTransportError({
    deviceId: input.deviceId,
    kind: input.kind,
    sourceJobId: input.sourceJobId,
    apnsErrorTag: cause._tag,
    requestStage: cause._tag === "ApnsHttpRequestError" ? cause.stage : null,
    cause,
  });
  return Effect.logError(error.message).pipe(
    Effect.annotateLogs({
      error: Redacted.make(error, { label: error._tag }),
      "error.type": error._tag,
      "error.apns_error_tag": error.apnsErrorTag,
      ...(error.requestStage === null ? {} : { "error.request_stage": error.requestStage }),
      ...(error.stack === undefined ? {} : { "error.stack": error.stack }),
      "relay.mobile.device_id": error.deviceId,
      "relay.delivery.kind": error.kind,
      ...(error.sourceJobId === null ? {} : { "relay.delivery.job_id": error.sourceJobId }),
    }),
    Effect.as({
      ok: false,
      status: 0,
      reason: cause.message,
      apnsId: null,
    }),
  );
};

interface LiveActivityDeliveryTarget {
  readonly user_id: string;
  readonly device_id: string;
  readonly bundle_id?: string | null;
  readonly aps_environment?: "sandbox" | "production" | null;
}

// Bundle ids and APS environments vary by build; route per device to avoid DeviceTokenNotForTopic/BadDeviceToken.
function credentialsForTarget(
  credentials: RelayConfiguration.ApnsCredentials,
  target: LiveActivityDeliveryTarget,
): RelayConfiguration.ApnsCredentials {
  return {
    ...credentials,
    ...(target.bundle_id ? { bundleId: target.bundle_id } : {}),
    ...(target.aps_environment ? { environment: target.aps_environment } : {}),
  };
}

function expectedCurrentToken(input: {
  readonly target: LiveActivities.TargetRow;
  readonly kind: Exclude<RelayDeliveryKind, "live_activity_start">;
}): string | null {
  switch (input.kind) {
    case "live_activity_update":
    case "live_activity_end":
      return input.target.activity_push_token;
    case "push_notification":
      return input.target.push_token;
  }
}

interface SendLiveActivityDeliveryInputBase {
  readonly target: LiveActivityDeliveryTarget;
  readonly token: string;
  readonly sourceJobId: string;
}

export type SendLiveActivityDeliveryInput =
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_update";
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert?: ApnsLiveActivityAlert | null;
    })
  | (SendLiveActivityDeliveryInputBase & {
      readonly kind: "live_activity_end";
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert?: ApnsLiveActivityAlert | null;
    });

function makeLiveActivityDeliveryRequest(
  apns: Apns.ApnsClient["Service"],
  input: SendLiveActivityDeliveryInput,
  now: DateTime.DateTime,
) {
  const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const base = {
    token: input.token,
    nowEpochSeconds: epochSeconds,
    nowIso: DateTime.formatIso(now),
  };
  switch (input.kind) {
    case "live_activity_update":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: deliveryEvent(input.kind),
          state: input.aggregate,
          alert: input.alert ?? null,
        }),
      };
    case "live_activity_end":
      return {
        epochSeconds,
        iso: base.nowIso,
        request: apns.makeLiveActivityRequest({
          ...base,
          event: "end",
          state: input.aggregate,
          alert: input.alert ?? null,
        }),
      };
  }
}

export class ApnsDeliveries extends Context.Service<
  ApnsDeliveries,
  {
    readonly sendForTarget: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly nowMs: number;
      readonly replay?: boolean;
      /** The state whose new occurrence this publish announces, if any. */
      readonly trigger?: RelayAgentActivityState | null;
    }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
    readonly sendPushNotificationForTarget: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly trigger: RelayAgentActivityState;
    }) => Effect.Effect<RelayDeliveryResult | null, ApnsDeliveryError>;
    readonly sendLiveActivity: (
      input: SendLiveActivityDeliveryInput,
    ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
    readonly processSignedJob: (
      body: unknown,
    ) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
    readonly sendPushNotification: (input: {
      readonly target: LiveActivityDeliveryTarget;
      readonly token: string;
      readonly sourceJobId: string;
      readonly notification: ApnsNotificationPayload;
      readonly createdAt: string;
    }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryError>;
  }
>()("t3code-relay/agentActivity/ApnsDeliveries") {}

const make = Effect.gen(function* () {
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const deliveryQueue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const mac = yield* Mac.Mac;
  const apns = yield* Apns.ApnsClient;
  const activityRows = yield* AgentActivityRows.AgentActivityRows;

  const enqueuePushNotification = (
    target: LiveActivities.TargetRow,
    notification: ApnsNotificationPayload,
    token: string,
    options?: { readonly jobId: string },
  ) =>
    deliveryQueue.enqueuePushNotification({
      userId: target.user_id,
      deviceId: target.device_id,
      token,
      bundleId: target.bundle_id,
      apsEnvironment: target.aps_environment,
      notification,
      ...options,
    });

  const userHasContentToShow = Effect.fnUntraced(function* (userId: string) {
    const now = yield* DateTime.now;
    return yield* activityRows.listForUser({ userId }).pipe(
      Effect.map(
        (activeStates) =>
          makeAggregateState({
            activeStates,
            terminalState: null,
            nowMs: now.epochMilliseconds,
          }) !== null,
      ),
      // Keep the card on persistence failures; a later sweep can retry.
      Effect.catch((error) =>
        Effect.logWarning("Content recheck failed; keeping the card", { error }).pipe(
          Effect.as(true),
        ),
      ),
    );
  });

  const refreshAggregate = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly aggregate: RelayAgentActivityAggregateState;
    readonly nowMs: number;
    readonly hasAlert: boolean;
  }) {
    const { aggregate } = input;
    const currentStates = yield* activityRows.listForUser({ userId: input.userId });
    const currentByThread = new Map(
      currentStates.map((state) => [`${state.environmentId}\u0000${state.threadId}`, state]),
    );
    const activities = [];
    for (const row of aggregate.activities) {
      const current = currentByThread.get(`${row.environmentId}\u0000${row.threadId}`);
      if (current?.phase !== row.phase || current.updatedAt !== row.updatedAt) {
        return input.hasAlert
          ? makeAggregateState({
              activeStates: currentStates,
              terminalState: null,
              nowMs: input.nowMs,
            })
          : null;
      }
      const { notificationLevel: _queuedLevel, ...activity } = row;
      activities.push({
        ...activity,
        ...(current.notificationLevel === undefined
          ? {}
          : { notificationLevel: current.notificationLevel }),
      });
    }
    return { ...aggregate, activities };
  });

  const currentNotificationActivity = Effect.fnUntraced(function* (input: {
    readonly target: LiveActivities.TargetRow;
    readonly activity: Pick<
      ApnsNotificationPayload,
      "environmentId" | "threadId" | "phase" | "updatedAt" | "occurredAt"
    >;
    readonly nowMs: number;
  }) {
    const preferences = parsePreferences(input.target.preferences_json);
    if (preferences?.notificationsEnabled !== true) return null;
    const { activity } = input;
    const current = yield* activityRows.getForUserThread({
      userId: input.target.user_id,
      environmentId: activity.environmentId,
      threadId: activity.threadId,
      requireNotifications: true,
    });
    if (
      !current ||
      !isSameOccurrence(current, activity) ||
      isExpiredAgentActivityState(current, input.nowMs) ||
      !shouldAlertForActivity({ ...current, preferences, nowMs: input.nowMs })
    )
      return null;
    return current;
  });

  const currentDevice = Effect.fnUntraced(function* (target: LiveActivityDeliveryTarget) {
    const targets = yield* liveActivities.listTargets({ userId: target.user_id });
    return targets.find((row) => row.device_id === target.device_id) ?? null;
  });

  const isCurrentToken = (input: {
    readonly device: LiveActivities.TargetRow | null;
    readonly kind: Exclude<RelayDeliveryKind, "live_activity_start">;
    readonly token: string;
  }) =>
    input.device !== null &&
    expectedCurrentToken({ target: input.device, kind: input.kind }) === input.token
      ? input.device
      : null;

  const sendLiveActivity: ApnsDeliveries["Service"]["sendLiveActivity"] = Effect.fn(
    "relay.apns_deliveries.send_live_activity",
  )(function* (input) {
    if (!config.apns) {
      return {
        deviceId: input.target.device_id,
        kind: input.kind,
        ok: false,
        apnsStatus: null,
        apnsReason: "APNs is disabled for this relay.",
        apnsId: null,
      };
    }
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": input.target.device_id,
      "relay.delivery.kind": input.kind,
      ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
    });
    const now = yield* DateTime.now;
    const recoverTransportError = (cause: Apns.ApnsError) =>
      recoverApnsDeliveryTransportError(
        {
          deviceId: input.target.device_id,
          kind: input.kind,
          sourceJobId: input.sourceJobId ?? null,
        },
        cause,
      );
    const device = yield* currentDevice(input.target);
    const currentTarget = isCurrentToken({ device, kind: input.kind, token: input.token });
    const legacyMatches =
      input.alert && !input.alert.activity
        ? input.aggregate?.activities.filter((row) => {
            const notification = notificationForActivity(row);
            return (
              notification.title === input.alert?.title && notification.body === input.alert.body
            );
          })
        : undefined;
    const activity =
      input.alert?.activity ?? (legacyMatches?.length === 1 ? legacyMatches[0] : undefined);
    const current =
      device && activity && input.alert
        ? yield* currentNotificationActivity({
            target: device,
            activity,
            nowMs: now.epochMilliseconds,
          })
        : null;
    const cardShowsAlerts =
      currentTarget !== null &&
      parsePreferences(currentTarget.preferences_json)?.liveActivitiesEnabled !== false;
    const alert =
      current && input.alert && cardShowsAlerts
        ? { title: input.alert.title, body: input.alert.body }
        : null;
    const aggregate =
      currentTarget && input.aggregate
        ? yield* refreshAggregate({
            userId: currentTarget.user_id,
            aggregate: sanitizeAgentActivityAggregateState(input.aggregate),
            nowMs: now.epochMilliseconds,
            hasAlert: alert !== null,
          })
        : null;
    const claim = yield* attempts.claimSourceJob({
      userId: input.target.user_id,
      environmentId: null,
      threadId: null,
      deviceId: input.target.device_id,
      kind: input.kind,
      sourceJobId: input.sourceJobId,
      token: input.token,
    });
    if (claim === "completed") {
      return duplicateJobResult({ deviceId: input.target.device_id, kind: input.kind });
    }
    if (claim === "in_flight") {
      return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
    }
    // The alert is still due but this card cannot show it, so it goes out once as a standard push.
    if (current && device?.push_token && !cardShowsAlerts) {
      yield* enqueuePushNotification(device, notificationForState(current), device.push_token, {
        jobId: `${input.sourceJobId}:push`,
      });
    }
    if (!currentTarget) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
    }
    if (input.aggregate !== null && aggregate === null) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        apnsReason: "Stale agent activity state skipped.",
      });
      return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
    }
    // A contentless end must not retire a card that newer work now owns. An
    // end for a device that turned Live Activities off still goes out.
    if (
      input.kind === "live_activity_end" &&
      aggregate === null &&
      parsePreferences(currentTarget.preferences_json)?.liveActivitiesEnabled !== false &&
      (yield* userHasContentToShow(input.target.user_id))
    ) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        apnsReason: "Stale APNs end job skipped.",
      });
      return staleJobResult({ deviceId: input.target.device_id, kind: input.kind });
    }
    const { epochSeconds, iso, request } = makeLiveActivityDeliveryRequest(
      apns,
      input.kind === "live_activity_update"
        ? { ...input, aggregate: aggregate ?? input.aggregate, alert }
        : { ...input, aggregate, alert },
      now,
    );
    const result = yield* apns
      .sendLiveActivityRequest({
        credentials: credentialsForTarget(config.apns, currentTarget),
        request,
        issuedAtUnixSeconds: epochSeconds,
      })
      .pipe(
        Effect.catchTags({
          ApnsJwtEncodingError: recoverTransportError,
          ApnsJwtSigningError: recoverTransportError,
          ApnsHttpRequestError: recoverTransportError,
        }),
      );
    if (result.ok) {
      yield* liveActivities.markDelivery({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: input.kind,
        aggregate,
        deliveredAt: iso,
      });
    } else if (isPermanentApnsTokenFailure(result)) {
      yield* liveActivities.invalidateDeliveryToken({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: input.kind,
        invalidatedAt: iso,
      });
    }
    yield* attempts.completeSourceJob({
      sourceJobId: input.sourceJobId,
      ...deliveryAttemptOutcome(result),
    });
    return {
      deviceId: input.target.device_id,
      kind: input.kind,
      ok: result.ok,
      apnsStatus: result.status === 0 ? null : result.status,
      apnsReason: result.reason ?? null,
      apnsId: result.apnsId,
    };
  });

  const sendPushNotification: ApnsDeliveries["Service"]["sendPushNotification"] = Effect.fn(
    "relay.apns_deliveries.send_push_notification",
  )(function* (input) {
    if (!config.apns) {
      return {
        deviceId: input.target.device_id,
        kind: "push_notification",
        ok: false,
        apnsStatus: null,
        apnsReason: "APNs is disabled for this relay.",
        apnsId: null,
      };
    }
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": input.target.device_id,
      "relay.delivery.kind": "push_notification",
      ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
    });
    const now = yield* DateTime.now;
    const epochSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const notification = sanitizeApnsNotificationPayload(input.notification);
    yield* Effect.annotateCurrentSpan({
      "relay.environment_id": notification.environmentId,
      "relay.thread_id": notification.threadId,
    });
    const request = apns.makePushNotificationRequest({
      token: input.token,
      notification,
    });
    const recoverTransportError = (cause: Apns.ApnsError) =>
      recoverApnsDeliveryTransportError(
        {
          deviceId: input.target.device_id,
          kind: "push_notification",
          sourceJobId: input.sourceJobId ?? null,
        },
        cause,
      );
    const currentTarget = isCurrentToken({
      device: yield* currentDevice(input.target),
      kind: "push_notification",
      token: input.token,
    });
    const current = currentTarget
      ? yield* currentNotificationActivity({
          target: currentTarget,
          activity: notification,
          nowMs: now.epochMilliseconds,
        })
      : null;
    const currentNotification = current
      ? notificationForActivity(aggregateRowForState(current))
      : null;
    // Legacy jobs lack an activity identity. Match their content against work that existed when queued.
    const verified =
      current !== null &&
      ((notification.phase !== undefined && notification.updatedAt !== undefined) ||
        (current.updatedAt <= input.createdAt &&
          currentNotification?.title === notification.title &&
          currentNotification.body === notification.body &&
          currentNotification.deepLink === notification.deepLink));
    const claim = yield* attempts.claimSourceJob({
      userId: input.target.user_id,
      environmentId: notification.environmentId,
      threadId: notification.threadId,
      deviceId: input.target.device_id,
      kind: "push_notification",
      sourceJobId: input.sourceJobId,
      token: input.token,
    });
    if (claim === "completed") {
      return duplicateJobResult({
        deviceId: input.target.device_id,
        kind: "push_notification",
      });
    }
    if (claim === "in_flight") {
      return yield* new ApnsDeliveryJobClaimInFlight({ sourceJobId: input.sourceJobId });
    }
    if (!currentTarget) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      return staleJobResult({
        deviceId: input.target.device_id,
        kind: "push_notification",
      });
    }
    if (!verified) {
      yield* attempts.completeSourceJob({
        sourceJobId: input.sourceJobId,
        apnsReason: "Notification is disabled, superseded, or no longer fresh.",
      });
      return staleJobResult({ deviceId: input.target.device_id, kind: "push_notification" });
    }
    const result = yield* apns
      .sendPushNotificationRequest({
        credentials: credentialsForTarget(config.apns, currentTarget),
        request,
        issuedAtUnixSeconds: epochSeconds,
      })
      .pipe(
        Effect.catchTags({
          ApnsJwtEncodingError: recoverTransportError,
          ApnsJwtSigningError: recoverTransportError,
          ApnsHttpRequestError: recoverTransportError,
        }),
      );
    if (isPermanentApnsTokenFailure(result)) {
      yield* liveActivities.invalidateDeliveryToken({
        userId: input.target.user_id,
        deviceId: input.target.device_id,
        kind: "push_notification",
        invalidatedAt: DateTime.formatIso(now),
      });
    }
    yield* attempts.completeSourceJob({
      sourceJobId: input.sourceJobId,
      ...deliveryAttemptOutcome(result),
    });
    return {
      deviceId: input.target.device_id,
      kind: "push_notification" as const,
      ok: result.ok,
      apnsStatus: result.status === 0 ? null : result.status,
      apnsReason: result.reason ?? null,
      apnsId: result.apnsId,
    };
  });

  const processSignedJob: ApnsDeliveries["Service"]["processSignedJob"] = Effect.fn(
    "relay.apns_deliveries.process_signed_job",
  )(function* (body) {
    const signedJob = yield* decodeSignedApnsDeliveryJob(body).pipe(
      Effect.mapError(
        (cause) =>
          new ApnsDeliveryJobQueuePayloadInvalid({
            receivedType: Array.isArray(body) ? "array" : body === null ? "null" : typeof body,
            cause,
          }),
      ),
    );
    const now = yield* DateTime.now;
    const payload = yield* verifySignedApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      job: signedJob,
      nowMs: now.epochMilliseconds,
    }).pipe(Effect.provideService(Mac.Mac, mac));
    yield* Effect.annotateCurrentSpan({
      "relay.mobile.device_id": payload.target.deviceId,
      "relay.delivery.kind": payload.kind,
      "relay.delivery.job_id": payload.jobId,
    });
    return yield* Effect.suspend(() => {
      switch (payload.kind) {
        case "live_activity_update":
          if (payload.aggregate === null) {
            return Effect.fail(
              new ApnsDeliveryJobLiveActivityAggregateMissing({
                jobId: payload.jobId,
                kind: payload.kind,
                userId: payload.target.userId,
                deviceId: payload.target.deviceId,
              }),
            );
          }
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
            alert: payload.alert ?? null,
          });
        case "live_activity_end":
          return sendLiveActivity({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            kind: payload.kind,
            aggregate: payload.aggregate,
            alert: payload.alert ?? null,
          });
        case "push_notification":
          if (payload.notification === null) {
            return Effect.fail(
              new ApnsDeliveryJobPushNotificationMissing({
                jobId: payload.jobId,
                userId: payload.target.userId,
                deviceId: payload.target.deviceId,
              }),
            );
          }
          return sendPushNotification({
            target: {
              user_id: payload.target.userId,
              device_id: payload.target.deviceId,
              bundle_id: payload.target.bundleId ?? null,
              aps_environment: payload.target.apsEnvironment ?? null,
            },
            token: payload.target.token,
            sourceJobId: payload.jobId,
            notification: payload.notification,
            createdAt: payload.createdAt,
          });
      }
    }).pipe(withSpanAttributes({ "user.id": payload.target.userId }));
  });

  return ApnsDeliveries.of({
    sendLiveActivity,
    sendPushNotification,
    processSignedJob,
    sendPushNotificationForTarget: Effect.fnUntraced(function* (input) {
      if (!config.apns) return null;
      const now = yield* DateTime.now;
      const notification = notificationForTrigger({ ...input, nowMs: now.epochMilliseconds });
      return yield* notification && input.target.push_token
        ? enqueuePushNotification(input.target, notification, input.target.push_token)
        : Effect.succeed(null);
    }),
    sendForTarget: Effect.fnUntraced(function* (input) {
      if (!config.apns) return null;
      const { target, trigger } = input;
      const notification = input.replay ? null : notificationForTrigger(input);
      const delivery = chooseLiveActivityDelivery({ ...input, hasAlert: notification !== null });
      if (delivery === "suppressed") return null;
      const alertOnCard =
        delivery?.kind === "live_activity_update" ||
        (delivery?.kind === "live_activity_end" &&
          !target.push_token &&
          parsePreferences(target.preferences_json)?.liveActivitiesEnabled !== false);
      const alert =
        notification && trigger && alertOnCard
          ? {
              title: notification.title,
              body: notification.body,
              activity: {
                environmentId: trigger.environmentId,
                threadId: trigger.threadId,
                phase: trigger.phase,
                updatedAt: trigger.updatedAt,
                ...(trigger.occurredAt === undefined ? {} : { occurredAt: trigger.occurredAt }),
              },
            }
          : null;
      const result = delivery
        ? yield* deliveryQueue.enqueueLiveActivity({
            userId: target.user_id,
            deviceId: target.device_id,
            kind: delivery.kind,
            token: delivery.token,
            bundleId: target.bundle_id,
            apsEnvironment: target.aps_environment,
            aggregate: delivery.aggregate,
            alert,
          })
        : null;
      if (notification && target.push_token && alert === null) {
        const push = yield* enqueuePushNotification(target, notification, target.push_token);
        return result ?? push;
      }
      return result;
    }),
  });
});

export const layer = Layer.effect(ApnsDeliveries, make);
