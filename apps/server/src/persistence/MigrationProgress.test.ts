// Serve the raw Node listener a starting server answers with before its routes attach.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import { ENVIRONMENT_DESCRIPTOR_PATH } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { rejectRequestsUntilServing } from "../httpResponseErrorGuard.ts";
import * as MigrationProgress from "./MigrationProgress.ts";
import { runMigrations } from "./Migrations.ts";

const LEGACY_ROOT = `node:run:${encodeURIComponent("run:thread:mcp%3Alaunch%3Aabc:ordinal:1")}:root`;

const listen = (server: NodeHttp.Server) =>
  Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed((server.address() as NodeNet.AddressInfo).port));
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );

const get = (port: number, path: string) =>
  Effect.callback<{ readonly status: number; readonly body: string }>((resume) => {
    NodeHttp.get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resume(Effect.succeed({ status: response.statusCode ?? 0, body })));
    }).on("error", (error) => resume(Effect.die(error)));
  });

it.effect("signals a migration's start and each whole percent, not every batch", () =>
  Effect.gen(function* () {
    let advances = 0;
    const progress = MigrationProgress.make(Effect.sync(() => void advances++));
    for (const status of [
      { migration: "90_A" },
      { migration: "91_B" },
      { migration: "91_B", progress: 0.001 },
      { migration: "91_B", progress: 0.004 },
      { migration: "91_B", progress: 0.012 },
      { migration: "91_B", progress: 0.019 },
      undefined,
    ]) {
      yield* progress.report(status);
    }
    assert.strictEqual(advances, 4);
  }),
);

it.effect("a server migrating a large database answers its descriptor path with the progress", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 90 });
    const payload = JSON.stringify({ id: LEGACY_ROOT, filler: "x".repeat(20_000) });
    for (let index = 1; index <= 400; index++) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          ${`event:${index}`}, 'thread', 'thread-1', ${index}, 'node.updated',
          '2026-11-14T00:00:00.000Z', 'system', ${payload}, '{}'
        )
      `;
    }
    const progress = yield* MigrationProgress.MigrationProgress;
    const port = yield* listen(
      rejectRequestsUntilServing(NodeHttp.createServer(), progress.current),
    );
    const midway = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    // Holds the migration between two committed steps, where the server answers requests.
    const pausedMidway = MigrationProgress.MigrationProgress.of({
      ...progress,
      report: (status) =>
        progress
          .report(status)
          .pipe(
            Effect.andThen(
              status?.progress !== undefined && status.progress > 0 && status.progress < 1
                ? Deferred.succeed(midway, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
            ),
          ),
    });

    const migrating = yield* runMigrations().pipe(
      Effect.provideService(MigrationProgress.MigrationProgress, pausedMidway),
      Effect.forkChild,
    );
    yield* Deferred.await(midway);
    const descriptor = yield* get(port, ENVIRONMENT_DESCRIPTOR_PATH);
    const otherRoute = yield* get(port, "/api/auth/session");
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(migrating);
    const afterMigration = yield* get(port, ENVIRONMENT_DESCRIPTOR_PATH);

    assert.strictEqual(descriptor.status, 503);
    const { startup } = JSON.parse(descriptor.body) as {
      readonly startup: { readonly migration: string; readonly progress: number };
    };
    assert.strictEqual(startup.migration, "91_CompactOrchestrationIds");
    assert.isTrue(startup.progress > 0 && startup.progress < 1);
    assert.deepStrictEqual(otherRoute, { status: 503, body: "" });
    assert.deepStrictEqual(afterMigration, { status: 503, body: "" });
  }).pipe(
    Effect.provide(
      Layer.merge(MigrationProgress.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);
