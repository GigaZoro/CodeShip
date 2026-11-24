import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { RelayAgentActivityState as RelayAgentActivityStateSchema } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayAgentActivityRows, relayEnvironmentLinks } from "../persistence/schema.ts";

export class AgentActivityRowUpsertPersistenceError extends Schema.TaggedError<AgentActivityRowUpsertPersistenceError>()(
  "AgentActivityRowUpsertPersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowDeletePersistenceError extends Schema.TaggedError<AgentActivityRowDeletePersistenceError>()(
  "AgentActivityRowDeletePersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowPruneTerminalPersistenceError extends Schema.TaggedError<AgentActivityRowPruneTerminalPersistenceError>()(
  "AgentActivityRowPruneTerminalPersistenceError",
  {
    updatedBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prune terminal agent activity rows updated before ${this.updatedBefore}.`;
  }
}

export class AgentActivityRowListPersistenceError extends Schema.TaggedError<AgentActivityRowListPersistenceError>()(
  "AgentActivityRowListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list agent activity state for user ${this.userId}.`;
  }
}

/** The stored row's occurrence before an upsert replaced it. */
export interface AgentActivityOccurrence {
  readonly phase: string;
  readonly occurredAt: string | null;
  /** The publish that wrote it meant to alert but failed before every delivery was queued. */
  readonly alertUnsent: boolean;
}

const whereThreadRow = (input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly threadId: string;
}) =>
  and(
    eq(relayAgentActivityRows.environmentId, input.environmentId),
    eq(relayAgentActivityRows.environmentPublicKey, input.environmentPublicKey),
    eq(relayAgentActivityRows.threadId, input.threadId),
  );

export class AgentActivityRows extends Context.Service<
  AgentActivityRows,
  {
    /** Writes the state and returns the occurrence it replaced; silent publishes return null. */
    readonly upsert: (input: {
      readonly environmentPublicKey: string;
      readonly state: RelayAgentActivityState;
    }) => Effect.Effect<AgentActivityOccurrence | null, AgentActivityRowUpsertPersistenceError>;
    /** Lets the retry of a failed publish alert again; the next write of the row clears it. */
    readonly markAlertUnsent: (input: {
      readonly environmentPublicKey: string;
      readonly state: RelayAgentActivityState;
    }) => Effect.Effect<void, AgentActivityRowUpsertPersistenceError>;
    readonly pruneTerminal: (input: {
      readonly updatedBefore: string;
    }) => Effect.Effect<void, AgentActivityRowPruneTerminalPersistenceError>;
    readonly remove: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
    }) => Effect.Effect<void, AgentActivityRowDeletePersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayAgentActivityState>,
      AgentActivityRowListPersistenceError
    >;
    readonly getForUserThread: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly threadId: string;
      readonly requireNotifications?: boolean;
    }) => Effect.Effect<RelayAgentActivityState | null, AgentActivityRowListPersistenceError>;
  }
>()("t3code-relay/agentActivity/AgentActivityRows") {}

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeRelayAgentActivityStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const decodeRelayAgentActivityState = Schema.decodeUnknownOption(RelayAgentActivityStateSchema);

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return AgentActivityRows.of({
    upsert: Effect.fn("relay.agent_activity_rows.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.state.environmentId,
        "relay.thread_id": input.state.threadId,
      });
      const persistenceError = (cause: unknown) =>
        new AgentActivityRowUpsertPersistenceError({
          environmentId: input.state.environmentId,
          threadId: input.state.threadId,
          cause,
        });
      const whereRow = whereThreadRow({
        environmentId: input.state.environmentId,
        environmentPublicKey: input.environmentPublicKey,
        threadId: input.state.threadId,
      });
      if (input.state.silent) {
        // A preference publish can outlive the server's copy of the relay activity identity.
        yield* db
          .update(relayAgentActivityRows)
          .set({
            stateJson: sql`${relayAgentActivityRows.stateJson} || jsonb_build_object('notificationLevel', ${input.state.notificationLevel ?? "default"}::text)`,
          })
          .where(whereRow)
          .pipe(Effect.mapError(persistenceError));
        return null;
      }
      const now = yield* DateTime.now;
      const stateJson = yield* encodeRelayAgentActivityStateJson(input.state).pipe(
        Effect.flatMap(decodeJsonString),
        Effect.map(Function.cast<unknown, RelayAgentActivityState>),
        Effect.mapError(persistenceError),
      );
      const values = {
        environmentId: input.state.environmentId,
        environmentPublicKey: input.environmentPublicKey,
        threadId: input.state.threadId,
        stateJson,
        updatedAt: input.state.updatedAt,
        createdAt: DateTime.formatIso(now),
      };
      const target = [
        relayAgentActivityRows.environmentId,
        relayAgentActivityRows.environmentPublicKey,
        relayAgentActivityRows.threadId,
      ];
      // The row lock makes concurrent publishes of one thread see each other's occurrence.
      const replace = Effect.gen(function* () {
        const inserted = yield* db
          .insert(relayAgentActivityRows)
          .values(values)
          .onConflictDoNothing({ target })
          .returning({ threadId: relayAgentActivityRows.threadId });
        if (inserted.length > 0) {
          return null;
        }
        const previous = yield* db
          .select({
            phase: sql<string | null>`${relayAgentActivityRows.stateJson} ->> 'phase'`,
            occurredAt: sql<string | null>`${relayAgentActivityRows.stateJson} ->> 'occurredAt'`,
            alertUnsent: sql<string | null>`${relayAgentActivityRows.stateJson} ->> 'alertUnsent'`,
          })
          .from(relayAgentActivityRows)
          .where(whereRow)
          .limit(1)
          .for("update");
        yield* db
          .insert(relayAgentActivityRows)
          .values(values)
          .onConflictDoUpdate({ target, set: { stateJson, updatedAt: input.state.updatedAt } });
        const row = previous[0];
        return row?.phase == null
          ? null
          : {
              phase: row.phase,
              occurredAt: row.occurredAt,
              alertUnsent: row.alertUnsent === "true",
            };
      });
      return yield* db.$client.withTransaction(replace).pipe(Effect.mapError(persistenceError));
    }),

    markAlertUnsent: Effect.fn("relay.agent_activity_rows.mark_alert_unsent")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.state.environmentId,
        "relay.thread_id": input.state.threadId,
      });
      yield* db
        .update(relayAgentActivityRows)
        .set({
          stateJson: sql`${relayAgentActivityRows.stateJson} || jsonb_build_object('alertUnsent', true)`,
        })
        .where(
          and(
            whereThreadRow({
              environmentId: input.state.environmentId,
              environmentPublicKey: input.environmentPublicKey,
              threadId: input.state.threadId,
            }),
            // Only the state this publish wrote; a newer one made its own alert decision.
            eq(relayAgentActivityRows.updatedAt, input.state.updatedAt),
            sql`${relayAgentActivityRows.stateJson} ->> 'phase' = ${input.state.phase}`,
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowUpsertPersistenceError({
                environmentId: input.state.environmentId,
                threadId: input.state.threadId,
                cause,
              }),
          ),
        );
    }),

    remove: Effect.fn("relay.agent_activity_rows.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(whereThreadRow(input))
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowDeletePersistenceError({
                environmentId: input.environmentId,
                threadId: input.threadId,
                cause,
              }),
          ),
        );
    }),

    pruneTerminal: Effect.fn("relay.agent_activity_rows.prune_terminal")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.agent_activity_prune.before": input.updatedBefore,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(
          and(
            sql`${relayAgentActivityRows.stateJson} ->> 'phase' IN ('completed', 'failed')`,
            lt(relayAgentActivityRows.updatedAt, input.updatedBefore),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowPruneTerminalPersistenceError({
                updatedBefore: input.updatedBefore,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.agent_activity_rows.list_for_user")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => Option.toArray(decodeRelayAgentActivityState(row.stateJson))),
          ),
          Effect.mapError(
            (cause) =>
              new AgentActivityRowListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    getForUserThread: Effect.fn("relay.agent_activity_rows.get_for_user_thread")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayAgentActivityRows.environmentId, input.environmentId),
            eq(relayAgentActivityRows.threadId, input.threadId),
            input.requireNotifications
              ? eq(relayEnvironmentLinks.notificationsEnabled, true)
              : undefined,
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.map((rows) => {
            for (const row of rows) {
              const decoded = decodeRelayAgentActivityState(row.stateJson);
              if (Option.isSome(decoded)) {
                return decoded.value;
              }
            }
            return null;
          }),
          Effect.mapError(
            (cause) =>
              new AgentActivityRowListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(AgentActivityRows, make);
