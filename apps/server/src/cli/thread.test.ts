// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { GitCommandError, RunId, ThreadId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";

import { deriveServerPaths, WORKTREE_RELEASE_DIRECTORY } from "../config.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "../vcs/GitVcsDriverCore.testkit.ts";
import {
  decodeReleaseRequest,
  releasePath,
  worktreeReleaseName,
} from "../workspace/worktreeRelease.ts";
import { readLatestMessages, threadCommand, type ThreadTools, waitForRun } from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

const releaseCliLayer = Layer.mergeAll(
  layerTest,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);

const releaseCliFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = yield* releasePath(yield* makeTmpDir("thread-release-cli-"));
  const repo = path.join(temp, "primary");
  const { initialBranch } = yield* initRepoWithCommit(repo);
  const durableRef = "refs/heads/" + initialBranch;
  const parent = path.join(temp, "checkouts");
  const checkout = path.join(parent, "finished checkout");
  yield* fs.makeDirectory(parent);
  yield* git(repo, ["worktree", "add", "-b", "finished", checkout]);

  const baseDir = path.join(temp, "server");
  const { stateDir, dbPath } = yield* deriveServerPaths(baseDir, undefined);
  yield* fs.makeDirectory(stateDir, { recursive: true });
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath)),
    (database) => Effect.sync(() => database.close()),
  );
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, payload_json TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs (
      thread_id TEXT, run_id TEXT, ordinal INTEGER);
  `);
  const bind = (id: string, spelling: string, parentId: string | null = null, archived = false) => {
    const lineage = {
      rootThreadId: parentId ?? id,
      parentThreadId: parentId,
      relationshipToParent: parentId === null ? null : "subagent",
    };
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?, 'project', ?, NULL)").run(
      id,
      JSON.stringify({
        branch: "finished",
        lineage,
        archivedAt: archived ? "2026-01-01T00:00:00Z" : null,
        worktreePath: spelling,
      }),
    );
    db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES(?, ?, 1)").run(id, id + "-run");
  };
  const release = (id: string, spelling: string, ...flags: string[]) =>
    Command.runWith(threadCommand, { version: "0.0.0" })([
      "release-worktree",
      id,
      "--run",
      id + "-run",
      "--worktree",
      spelling,
      "--durable-ref",
      durableRef,
      "--base-dir",
      baseDir,
      ...flags,
    ]);
  const requestFile = path.join(
    stateDir,
    WORKTREE_RELEASE_DIRECTORY,
    worktreeReleaseName(checkout),
  );
  const request = fs.readFileString(requestFile).pipe(Effect.flatMap(decodeReleaseRequest));
  return { temp, checkout, db, bind, release, durableRef, requestFile, request };
});

it.live("release-worktree queues an ordinary request when --save-ignored is omitted", () =>
  Effect.gen(function* () {
    const { checkout, bind, release, durableRef, request } = yield* releaseCliFixture;
    bind("owner", checkout);
    yield* release("owner", checkout);
    const queued = yield* request;
    assert.strictEqual(queued.threadId, "owner");
    assert.strictEqual(queued.runId, "owner-run");
    assert.strictEqual(queued.durableRef, durableRef);
    assert.isUndefined(queued.family);
    assert.isUndefined(queued.savedFiles);
  }).pipe(Effect.provide(releaseCliLayer), Effect.scoped),
);

it.live("release-worktree binds every owner across aliased checkout parents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { temp, checkout, db, bind, release, requestFile, request } = yield* releaseCliFixture;
    const alias = path.join(temp, "parent-alias");
    const otherAlias = path.join(temp, "other-parent-alias");
    for (const name of [alias, otherAlias])
      yield* Effect.promise(() => NodeFSP.symlink(path.dirname(checkout), name, "junction"));
    const ownerCheckout = path.join(alias, path.basename(checkout));
    const childCheckout = path.join(otherAlias, path.basename(checkout));
    const issue = (id: string, spelling = checkout) => release(id, spelling, "--no-save-ignored");

    assert.instanceOf(yield* Effect.flip(issue("root")), GitCommandError);
    assert.isFalse(yield* fs.exists(requestFile));
    bind("root", ownerCheckout, null);
    bind("child", childCheckout, "root", true);
    assert.instanceOf(yield* Effect.flip(issue("child", childCheckout)), GitCommandError);
    assert.isFalse(yield* fs.exists(requestFile));
    const staleParent = path.join(temp, "former-worktree-parent");
    yield* fs.writeFileString(staleParent, "replacement");
    bind("historical", path.join(staleParent, path.basename(checkout)), null, true);
    yield* issue("root");
    const approved = yield* request;
    assert.deepStrictEqual(
      approved.family?.map((member) => member.threadId),
      ["child", "root"],
    );
    assert.strictEqual(approved.worktreePath, checkout);

    bind("unrelated", checkout, null);
    assert.instanceOf(yield* Effect.flip(issue("root")), GitCommandError);
    assert.deepStrictEqual(yield* request, approved);
    db.exec(
      "UPDATE orchestration_v2_projection_threads SET deleted_at='closed' WHERE thread_id IN ('child','unrelated')",
    );
    assert.instanceOf(yield* Effect.flip(issue("unrelated")), GitCommandError);
    assert.deepStrictEqual(yield* request, approved);
    yield* issue("root", ownerCheckout);
    assert.isUndefined((yield* request).family);
  }).pipe(Effect.provide(releaseCliLayer), Effect.scoped),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);
