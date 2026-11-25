// @effect-diagnostics nodeBuiltinImport:off - disposable native CLI and Git integration.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  OrchestrationV2ConversationMessageJson,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { parseCommandLine } from "./lib/command-line.ts";
import { EVAL_INSTANCE, EVAL_MODEL, startEnvironment } from "./mobile-behavior/environment.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const isRegistered = (repo: string, checkout: string) =>
  git(repo, "worktree", "list", "--porcelain", "-z")
    .split("\0")
    .some(
      (entry) =>
        entry.startsWith("worktree ") && NodePath.relative(checkout, entry.slice(9)) === "",
    );
let nextId = 0;
const commandId = () => CommandId.make("command-" + ++nextId);
const threadId = () => ThreadId.make("thread-" + ++nextId);
const readRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: ThreadId,
      runId: Schema.String,
      worktreePath: Schema.String,
      branch: Schema.String,
      head: Schema.String,
      family: Schema.optional(Schema.Array(Schema.Struct({ threadId: ThreadId }))),
    }),
  ),
);
const modelSelection = { instanceId: EVAL_INSTANCE, model: EVAL_MODEL };
const readWake = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const scenarios = [
  "parent",
  "child",
  "concurrent",
  "delivered-delegate",
  "new-fork-after-release",
  "new-side-chat-after-release",
  "deleted-empty-side-chat",
  "singleton",
  "interrupted",
  "new-run",
  "new-member",
  "unrelated",
  "failed",
  "ignored",
  "undelivered",
] as const;
type Scenario = (typeof scenarios)[number];

// The Windows regression can run just the parent and child follow-ups against the real server.
const { values } = parseCommandLine({
  options: { "windows-short-paths": { type: "boolean", default: false } },
});
const shortPathsOnly = values["windows-short-paths"];
const windowsShortDirectory = (directory: string) => {
  const long = NodeFS.realpathSync.native(directory);
  const short = NodeChildProcess.execFileSync(
    "cmd.exe",
    ["/d", "/u", "/c", "for %I in (.) do @echo %~fsI"],
    { cwd: long, encoding: "utf16le" },
  ).trim();
  NodeAssert.equal(NodeFS.realpathSync.native(short), long);
  return NodePath.relative(short, long) === "" ? undefined : short;
};

let phase = "starting the disposable server";
const fixturePath = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "codeship-family-" });
      const windows = yield* HostProcess.isWindows;
      const shortRoot = windows ? windowsShortDirectory(fixtureRoot) : undefined;
      const unavailable = "Windows 8.3 coverage requires a distinct short name on the temp volume.";
      if (shortPathsOnly) NodeAssert.ok(shortRoot, unavailable);
      if (windows && !shortRoot) yield* Effect.logInfo(unavailable);
      // startEnvironment removes its base before setup. Keep the actual short-name ancestor alive.
      const baseDir = NodePath.join(shortRoot ?? fixtureRoot, "fixture");
      yield* Effect.logInfo("Disposable fixture", baseDir);
      const env = yield* startEnvironment({ baseDir, deviceHost: "127.0.0.1" });
      const { workspace, projectId } = env;
      const client = env.releaseClient();
      const base = git(workspace, "branch", "--show-current");
      NodeFS.appendFileSync(NodePath.join(workspace, ".git/info/exclude"), "\nlocal-proof.env\n");
      const dispatch = client["orchestration.dispatchCommand"];
      const fork = (sourceThreadId: ThreadId, targetThreadId: ThreadId, sideChat = true) =>
        dispatch({
          type: "thread.fork",
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          title: "Side chat",
          sideChat,
          createdBy: "user",
          creationSource: "web",
          commandId: commandId(),
        });
      const detach = Effect.fn("proof.detach")(function* (
        projection: OrchestrationV2ThreadProjection,
      ) {
        for (const session of projection.providerSessions) {
          if (session.status !== "stopped")
            yield* dispatch({
              type: "provider-session.detach",
              threadId: projection.thread.id,
              providerSessionId: session.id,
              commandId: commandId(),
            });
        }
      });
      const settle = Effect.fn("proof.settle")(function* (
        projection: OrchestrationV2ThreadProjection,
      ) {
        yield* detach(projection);
        yield* dispatch({
          type: "thread.settle",
          threadId: projection.thread.id,
          commandId: commandId(),
        });
      });
      // The RPC client must keep processing heartbeats while the owner CLI inspects the checkout.
      const issue = (projection: OrchestrationV2ThreadProjection, signal: AbortSignal) => {
        const command = execFile(
          process.execPath,
          [
            NodePath.resolve(import.meta.dirname, "../apps/server/src/bin.ts"),
            "thread",
            "release-worktree",
            projection.thread.id,
            "--base-dir",
            baseDir,
            "--run",
            projection.runs.at(-1)!.id,
            "--worktree",
            projection.thread.worktreePath!,
            "--durable-ref",
            "refs/heads/" + base,
          ],
          { encoding: "utf8", signal },
        );
        command.child.stdin?.end();
        return command;
      };

      const fixtures: {
        scenario: Scenario;
        root: ThreadId;
        child: ThreadId;
        checkout: string;
        branch: string;
        file: string;
        request: ReturnType<typeof readRequest>;
      }[] = [];
      const selected = shortPathsOnly ? (["parent"] as const) : scenarios;
      for (const scenario of selected) {
        phase = `preparing the ${scenario} checkout`;
        const root = threadId();
        let child = threadId();
        const branch = "proof-" + scenario;
        const isDelegate = scenario === "undelivered" || scenario === "delivered-delegate";
        yield* client["orchestration.launchThread"]({
          commandId: commandId(),
          threadId: root,
          projectId,
          title: branch,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "worktree", baseRef: base, branch, startFromOrigin: false },
          initialMessage: {
            text: isDelegate ? `[[eval:hold:parent-${scenario}]]` : "first",
            attachments: [],
          },
        });
        if (isDelegate) {
          // Let held scripts observe their release before the server and control files disappear.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* env.release(`parent-${scenario}`);
              if (scenario === "delivered-delegate") yield* env.release("child-result");
              const finished = yield* env.settled(root);
              const delegate = finished.subagents.at(-1)?.childThreadId;
              if (delegate) yield* env.settled(delegate);
            }).pipe(Effect.timeout("15 seconds"), Effect.orDie),
          );
        }
        let parent = isDelegate
          ? yield* env.until("a running parent", root, (p) =>
              p.runs.at(-1)?.status === "running" && p.runs.at(-1)?.rootNodeId ? p : undefined,
            )
          : yield* env.settled(root);
        const checkout = parent.thread.worktreePath;
        NodeAssert.ok(checkout);
        if (isDelegate) {
          const run = parent.runs.at(-1)!;
          yield* dispatch({
            type: "delegated_task.request",
            parentThreadId: root,
            parentRunId: run.id,
            parentNodeId: run.rootNodeId!,
            task:
              scenario === "delivered-delegate"
                ? "Return a result. [[eval:hold:child-result]]"
                : "Return a result",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: commandId(),
          });
          child = yield* env.until(
            "a saved delegate",
            root,
            (p) => p.subagents.at(-1)?.childThreadId ?? undefined,
          );
          if (scenario === "delivered-delegate") {
            yield* env.until("delegate started", child, (p) =>
              p.runs.some((r) => r.status === "running") ? true : undefined,
            );
            yield* env.release("parent-delivered-delegate");
            yield* env.until("spawning run finished", root, (p) =>
              p.runs.find((r) => r.id === run.id)?.status === "completed" ? true : undefined,
            );
            yield* env.release("child-result");
            parent = yield* env.until("a separate terminal parent wake run", root, (p) => {
              const latest = p.runs.at(-1);
              return latest &&
                latest.id !== run.id &&
                ["completed", "failed", "cancelled", "interrupted"].includes(latest.status)
                ? p
                : undefined;
            });
            const consumer = parent.runs.at(-1)!;
            NodeAssert.equal(consumer.status, "completed");
            const task = parent.subagents.find((entry) => entry.childThreadId === child);
            NodeAssert.equal(task?.runId, run.id);
            NodeAssert.ok(task?.result);
            const childRun = (yield* env.settled(child)).runs.at(-1)!;
            NodeAssert.equal(childRun.status, "completed");

            // The bounded UI snapshot may omit the server's wake message. Read the fixture's
            // primary input and the exact child-result transfer from its read-only database.
            const database = new NodeSqlite.DatabaseSync(
              NodePath.join(baseDir, "userdata/statev2.sqlite"),
              { readOnly: true },
            );
            try {
              const row = database
                .prepare(`
                SELECT payload_json FROM orchestration_v2_projection_messages
                WHERE thread_id = ? AND run_id = ? AND message_id = ?
              `)
                .get(root, consumer.id, consumer.userMessageId);
              const wake = readWake(row?.payload_json);
              const detail = `Expected run ${consumer.id} to receive result ${task.id}`;
              NodeAssert.equal(wake.role, "user", detail);
              NodeAssert.equal(wake.createdBy, "agent", detail);
              NodeAssert.equal(wake.creationSource, "server", detail);
              NodeAssert.equal(wake.delegatedCompletion?.parentRunId, run.id, detail);
              NodeAssert.deepEqual(wake.delegatedCompletion?.taskIds, [task.id], detail);
              NodeAssert.ok(wake.text.endsWith("\n" + task.result), detail);
              NodeAssert.equal(task.completionDelivery?.state, "delivered", detail);
              const transfer = database
                .prepare(`
                SELECT 1 FROM orchestration_v2_projection_context_transfers
                WHERE source_thread_id = ? AND target_thread_id = ? AND target_run_id = ?
                  AND type = 'subagent_result' AND status = 'consumed'
                  AND json_extract(payload_json, '$.sourcePoint.runId') = ?
              `)
                .get(child, root, run.id, childRun.id);
              NodeAssert.ok(
                transfer,
                "Expected the completed child's result transfer to its spawning parent",
              );
            } finally {
              database.close();
            }
          }
        } else if (scenario !== "singleton") {
          NodeAssert.equal(parent.runs.at(-1)?.status, "completed");
          yield* fork(root, child);
          yield* env.send(child, scenario === "failed" ? "[[eval:fail]]" : "child");
        }
        phase = `settling the ${scenario} family and checking release eligibility`;
        if (scenario !== "singleton") {
          const member = yield* env.settled(child);
          NodeAssert.equal(member.thread.worktreePath, checkout);
          NodeAssert.equal(member.thread.branch, branch);
          NodeAssert.equal(
            member.runs.at(-1)?.status,
            scenario === "failed" ? "failed" : "completed",
          );
          if (scenario === "parent")
            yield* Effect.promise((signal) =>
              NodeAssert.rejects(issue(member, signal), { stdout: /Only the root/ }),
            );
          if (scenario === "undelivered") {
            const task = (yield* env.projection(root)).subagents.find(
              (item) => item.childThreadId === child,
            );
            NodeAssert.ok(task);
            NodeAssert.ok(
              !["acknowledged", "delivered"].includes(task.completionDelivery?.state ?? ""),
            );
          } else if (scenario === "delivered-delegate") yield* detach(member);
          else yield* settle(member);
        }
        if (scenario === "deleted-empty-side-chat") {
          const unused = threadId();
          yield* fork(root, unused);
          yield* Effect.promise((signal) =>
            NodeAssert.rejects(issue(parent, signal), { stdout: /no run to release/ }),
          );
          yield* dispatch({
            type: "thread.delete",
            threadId: unused,
            onlyIfUnused: true,
            commandId: commandId(),
          });
        }
        if (scenario !== "undelivered") yield* settle(parent);
        phase = `queueing and checking the ${scenario} owner request`;
        const { stdout } = yield* Effect.promise((signal) => issue(parent, signal));
        const file = stdout.match(/Queued worktree release in (.+)/)?.[1]?.trim();
        NodeAssert.ok(file);
        const request = readRequest(NodeFS.readFileSync(file, "utf8"));
        NodeAssert.equal(request.threadId, root);
        NodeAssert.equal(request.runId, parent.runs.at(-1)!.id);
        NodeAssert.equal(request.worktreePath, NodeFS.realpathSync.native(checkout));
        if (shortRoot && scenario === "parent") {
          const configuredRoot = NodePath.join(baseDir, "worktrees");
          const requestRoot = NodePath.dirname(NodePath.dirname(request.worktreePath));
          NodeAssert.equal(requestRoot, NodeFS.realpathSync.native(configuredRoot));
          NodeAssert.notEqual(NodePath.relative(configuredRoot, requestRoot), "");
          NodeAssert.notEqual(
            NodePath.relative(workspace, NodeFS.realpathSync.native(workspace)),
            "",
          );
        }
        NodeAssert.equal(request.branch, branch);
        NodeAssert.equal(request.head, git(checkout, "rev-parse", "HEAD"));
        NodeAssert.ok(isRegistered(workspace, request.worktreePath));
        if (scenario === "singleton") NodeAssert.equal(request.family, undefined);
        else
          NodeAssert.deepEqual(
            request.family?.map((member) => member.threadId).sort(),
            [root, child].sort(),
          );
        if (scenario === "new-member") yield* fork(root, threadId());
        if (scenario === "new-run") {
          yield* env.send(child, "New run after approval");
          yield* settle(yield* env.settled(child));
        }
        if (scenario === "unrelated")
          yield* client["orchestration.launchThread"]({
            commandId: commandId(),
            threadId: threadId(),
            projectId,
            title: "Unrelated owner",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "existing_worktree", worktreePath: checkout, branch },
          });
        if (scenario === "ignored")
          NodeFS.writeFileSync(NodePath.join(checkout, "local-proof.env"), "preserve");
        fixtures.push({ scenario, root, child, checkout, branch, file, request });
      }

      phase = "waiting for storage cleanup of the queued checkouts";
      // The production worker gives settlement scripts a minute to start a terminal.
      yield* Effect.sleep("65 seconds");
      const report = yield* client["server.runStorageCleanup"]({});
      const baseFile = "added-after-release.txt";
      NodeFS.writeFileSync(NodePath.join(workspace, baseFile), "from the new project base\n");
      git(workspace, "add", "--", baseFile);
      git(
        workspace,
        "-c",
        "user.name=proof",
        "-c",
        "user.email=proof@example.org",
        "commit",
        "-m",
        "new base",
      );
      const tip = git(workspace, "rev-parse", "HEAD");
      for (const f of fixtures) {
        phase = `checking the ${f.scenario} release outcome`;
        const removed = [
          "parent",
          "child",
          "singleton",
          "interrupted",
          "concurrent",
          "delivered-delegate",
          "new-fork-after-release",
          "new-side-chat-after-release",
          "deleted-empty-side-chat",
        ].includes(f.scenario);
        const reason = report.entries.find(
          (entry) => entry.path === f.checkout || entry.path === f.request.worktreePath,
        )?.reason;
        NodeAssert.equal(NodeFS.existsSync(f.file + ".released"), removed, reason);
        NodeAssert.equal(NodeFS.existsSync(f.checkout), !removed, reason);
        NodeAssert.equal(isRegistered(workspace, f.request.worktreePath), !removed, reason);
        if (!removed) {
          NodeAssert.ok(NodeFS.existsSync(f.file));
          if (f.scenario === "ignored")
            NodeAssert.equal(
              NodeFS.readFileSync(NodePath.join(f.checkout, "local-proof.env"), "utf8"),
              "preserve",
            );
          yield* Effect.logInfo(f.scenario, "kept", reason);
          continue;
        }
        const receipt = readRequest(NodeFS.readFileSync(f.file + ".released", "utf8"));
        NodeAssert.deepEqual(receipt, f.request);
        NodeAssert.equal(git(workspace, "rev-parse", "refs/heads/" + f.branch), f.request.head);
        phase = `resuming the ${f.scenario} checkout`;
        if (f.scenario === "parent") {
          const before = NodeFS.readFileSync(f.file + ".released");
          const projection = yield* env.projection(f.root);
          const target = projection.checkpoints.find((checkpoint) => checkpoint.status === "ready");
          NodeAssert.ok(target, "Expected a ready checkpoint for the released family");
          const requestId = commandId();
          yield* dispatch({
            type: "checkpoint.rollback",
            commandId: requestId,
            threadId: f.root,
            scopeId: target.scopeId,
            checkpointId: target.id,
            restoreFiles: false,
          });
          const failure = yield* env.until("rollback held for family recovery", f.root, (row) =>
            row.thread.rollbackFailure?.requestId === requestId
              ? row.thread.rollbackFailure
              : undefined,
          );
          NodeAssert.match(failure.message, /owning chat/);
          NodeAssert.deepEqual(NodeFS.readFileSync(f.file + ".released"), before);
          NodeAssert.equal(NodeFS.existsSync(f.checkout), false);
          NodeAssert.equal(isRegistered(workspace, f.request.worktreePath), false);
        }
        if (f.scenario === "interrupted") {
          const elsewhere = NodePath.join(baseDir, "elsewhere");
          git(workspace, "worktree", "add", elsewhere, f.branch);
          const previous = git(elsewhere, "rev-parse", "HEAD");
          NodeFS.writeFileSync(NodePath.join(elsewhere, "private.txt"), "owned elsewhere");
          yield* env.send(f.child, "Continue while branch is occupied");
          NodeAssert.equal((yield* env.settled(f.child)).runs.at(-1)?.status, "failed");
          NodeAssert.equal(git(elsewhere, "rev-parse", "HEAD"), previous);
          NodeAssert.equal(
            NodeFS.readFileSync(NodePath.join(elsewhere, "private.txt"), "utf8"),
            "owned elsewhere",
          );
          NodeFS.unlinkSync(NodePath.join(elsewhere, "private.txt"));
          git(workspace, "worktree", "remove", elsewhere);
          NodeAssert.ok(NodeFS.existsSync(f.file + ".restoring"));
          NodeFS.mkdirSync(f.checkout);
        }
        let ids =
          f.scenario === "singleton"
            ? [f.root]
            : f.scenario === "child"
              ? [f.child, f.root]
              : [f.root, f.child];
        if (
          f.scenario === "new-fork-after-release" ||
          f.scenario === "new-side-chat-after-release"
        ) {
          const descendant = threadId();
          yield* fork(f.root, descendant, f.scenario === "new-side-chat-after-release");
          ids = [descendant, ...ids];
        }
        yield* Effect.forEach(
          ids,
          (id) =>
            Effect.gen(function* () {
              const before = (yield* env.projection(id)).runs.at(-1)?.id;
              yield* env.send(id, "Continue");
              const followUp = yield* env.until("a completed follow-up", id, (projection) => {
                const latest = projection.runs.at(-1);
                return latest &&
                  latest.id !== before &&
                  ["completed", "failed", "interrupted", "cancelled"].includes(latest.status)
                  ? latest
                  : undefined;
              });
              NodeAssert.equal(followUp.status, "completed");
              NodeAssert.equal(git(f.checkout, "rev-parse", "HEAD"), tip);
              NodeAssert.equal(git(f.checkout, "branch", "--show-current"), f.branch);
              NodeAssert.deepEqual(
                NodeFS.readFileSync(NodePath.join(f.checkout, baseFile), "utf8").split(/\r?\n/),
                ["from the new project base", ""],
              );
            }),
          { concurrency: f.scenario === "concurrent" ? 2 : 1 },
        );
        NodeAssert.ok(!NodeFS.existsSync(f.file + ".restoring"));
        if (shortRoot && f.scenario === "parent") {
          NodeAssert.ok(!NodeFS.existsSync(f.file + ".released"));
          NodeAssert.ok(isRegistered(workspace, f.request.worktreePath));
          yield* Effect.logInfo("Releases and resumes a family across Windows 8.3 roots");
        }
        yield* Effect.logInfo(f.scenario, "released and resumed", tip);
      }
      return fixtureRoot;
    }),
  ).pipe(
    Effect.tapCause(() => Effect.logError(`Family release proof failed while ${phase}`)),
    Effect.provide(NodeServices.layer),
  ),
);
NodeAssert.ok(!NodeFS.existsSync(fixturePath), `Fixture directory still exists: ${fixturePath}`);
