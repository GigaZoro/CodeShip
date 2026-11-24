// @effect-diagnostics nodeBuiltinImport:off - snapshots and merges Vite+'s versioned SQLite cache.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const databaseName = "cache.db";

const SQLITE_BUSY = 5;
export const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error && "errcode" in cause && cause.errcode === SQLITE_BUSY;

function cacheVersions(cache: string) {
  if (!NodeFS.existsSync(cache)) return [];
  return NodeFS.readdirSync(cache, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && NodeFS.existsSync(NodePath.join(cache, entry.name, databaseName)),
    )
    .map((entry) => entry.name);
}

function seedVersion(source: string, destination: string, seed: string) {
  NodeFS.mkdirSync(seed, { recursive: true });
  const snapshot = NodePath.join(seed, databaseName);
  NodeFS.mkdirSync(destination, { recursive: true });
  const file = NodePath.join(destination, databaseName);
  try {
    using database = new NodeSqlite.DatabaseSync(NodePath.join(source, databaseName), {
      readOnly: true,
    });
    database.exec("PRAGMA busy_timeout = 100");
    database.prepare("VACUUM INTO ?").run(snapshot);
    NodeFS.copyFileSync(snapshot, file, NodeFS.constants.COPYFILE_FICLONE);
  } catch (error) {
    NodeFS.rmSync(snapshot, { force: true });
    NodeFS.rmSync(file, { force: true });
    throw error;
  }
}

function publishVersion(source: string, destination: string, seed: string) {
  NodeFS.mkdirSync(destination, { recursive: true });
  using database = new NodeSqlite.DatabaseSync(NodePath.join(destination, databaseName));
  database.exec("PRAGMA busy_timeout = 60000");
  database.prepare("ATTACH DATABASE ? AS p").run(NodePath.join(source, databaseName));
  const snapshot = NodePath.join(seed, databaseName);
  const seeded = NodeFS.existsSync(snapshot);
  if (seeded) database.prepare("ATTACH DATABASE ? AS seed").run(snapshot);
  database.exec("BEGIN IMMEDIATE");
  const sharedTable = database.prepare(
    "SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?",
  );
  const tables = database.prepare(
    "SELECT name, sql FROM p.sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'",
  );
  for (const { name, sql } of tables.all()) {
    if (typeof name !== "string" || typeof sql !== "string") {
      throw new Error("Invalid test cache table schema");
    }
    const existing = sharedTable.get(name);
    if (existing === undefined) database.exec(sql);
    else if (existing.sql !== sql) throw new Error(`Schema differs for table ${name}`);

    const table = `"${name.replaceAll('"', '""')}"`;
    const seededTable =
      seeded &&
      database
        .prepare("SELECT 1 FROM seed.sqlite_schema WHERE type = 'table' AND name = ?")
        .get(name);
    const difference = seededTable ? ` EXCEPT SELECT * FROM seed.${table}` : "";
    database.exec(`INSERT OR REPLACE INTO main.${table} SELECT * FROM p.${table}${difference}`);
  }
  database.exec("COMMIT");
}

const transferCache = Effect.fn("checkChanged.transferTestCache")(
  function* (
    from: string,
    to: string,
    seed: string,
    transfer: (source: string, destination: string, seed: string) => void,
    action: "seed" | "publish",
  ) {
    const versions = yield* Effect.try({ try: () => cacheVersions(from), catch: String });
    for (const version of versions) {
      yield* Effect.try({
        try: () =>
          transfer(
            NodePath.join(from, version),
            NodePath.join(to, version),
            NodePath.join(seed, version),
          ),
        catch: String,
      }).pipe(
        Effect.catch((error) =>
          Console.warn(`Could not ${action} test cache ${version}: ${error}`),
        ),
      );
    }
  },
  (effect, _from, _to, _seed, _transfer, action) =>
    effect.pipe(Effect.catch((error) => Console.warn(`Could not ${action} test cache: ${error}`))),
);

// Longer than any run lasts, so no running test step loses the partition it seeded from.
const unusedPartitionLimit = 3 * 24 * 60 * 60 * 1000;
// A run holds the lock for milliseconds, so one that finds it taken gets it soon. One held longer
// than the wait belongs to a stalled run, and this run keeps its own cache rather than wait on it.
const partitionLockRetry = "100 millis";
const partitionLockWaitMillis = 60_000;

// The lock is an exclusive transaction on this file, which the OS releases with its process.
function tryLockPartitions(partitions: string) {
  NodeFS.mkdirSync(partitions, { recursive: true });
  const lock = new NodeSqlite.DatabaseSync(`${partitions}.sqlite`);
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return lock;
  } catch (cause) {
    lock.close();
    if (isSqliteBusy(cause)) return undefined;
    throw cause;
  }
}

const holdPartitionLock = Effect.fnUntraced(function* (partitions: string) {
  const deadline = (yield* Clock.currentTimeMillis) + partitionLockWaitMillis;
  for (;;) {
    const lock = yield* Effect.uninterruptible(
      Effect.try({ try: () => tryLockPartitions(partitions), catch: String }).pipe(
        Effect.tap((lock) =>
          lock ? Effect.addFinalizer(() => Effect.sync(() => lock.close())) : Effect.void,
        ),
      ),
    );
    if (lock) return;
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* Effect.fail("another run has held its lock for a minute");
    }
    yield* Effect.sleep(partitionLockRetry);
  }
});

/**
 * Results replay only at the HEAD that recorded them, so each HEAD keeps its own partition. Under
 * one lock a run marks its partition used and removes those unused for days; a Windows removal that
 * another run's open database blocks waits for a later run. A run that cannot lock or mark its
 * partition gets none, since another run may remove it as unused while this one copies.
 */
export const testCachePartition = Effect.fn("checkChanged.testCachePartition")(
  function* (partitions: string, head: string) {
    yield* holdPartitionLock(partitions);
    const now = yield* Clock.currentTimeMillis;
    const others = yield* Effect.try({
      try: () => {
        const partition = NodePath.join(partitions, head);
        NodeFS.mkdirSync(partition, { recursive: true });
        NodeFS.utimesSync(partition, now / 1000, now / 1000);
        return NodeFS.readdirSync(partitions).filter((entry) => entry !== head);
      },
      catch: String,
    });
    for (const entry of others) {
      const other = NodePath.join(partitions, entry);
      yield* Effect.try({
        try: () => {
          const used = NodeFS.statSync(other, { throwIfNoEntry: false })?.mtimeMs ?? now;
          if (now - used > unusedPartitionLimit) {
            NodeFS.rmSync(other, { recursive: true, force: true });
          }
        },
        catch: String,
      }).pipe(
        Effect.catch((error) => Console.warn(`Could not remove test cache ${entry}: ${error}`)),
      );
    }
  },
  (effect, partitions, head) =>
    effect.pipe(
      Effect.scoped,
      Effect.as<string | undefined>(NodePath.join(partitions, head)),
      Effect.catch((error) =>
        Console.warn(
          `Could not prepare test cache ${head}, so this run keeps its own: ${error}`,
        ).pipe(Effect.as(undefined)),
      ),
    ),
);

export const stageTestCache = Effect.fn("checkChanged.stageTestCache")(function* <E, R>(
  shared: string | undefined,
  cache: string,
  snapshot: string,
  fingerprint: Effect.Effect<string, E, R>,
) {
  const seed = `${cache}.seed`;
  if (shared !== undefined) yield* transferCache(shared, cache, seed, seedVersion, "seed");
  const finish = yield* Effect.cached(
    fingerprint.pipe(
      Effect.flatMap((after) =>
        after === snapshot
          ? (shared === undefined
              ? Effect.void
              : transferCache(cache, shared, seed, publishVersion, "publish")
            ).pipe(Effect.as(true))
          : Console.warn(
              "Test results discarded: runtime inputs or HEAD changed during the test step. Run again.",
            ).pipe(Effect.as(false)),
      ),
      Effect.catch((error) =>
        Console.warn(`Could not validate test cache: ${String(error)}`).pipe(Effect.as(false)),
      ),
      Effect.uninterruptible,
    ),
  );
  yield* Effect.addFinalizer(() => finish);
  return { finish };
});
