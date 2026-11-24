// @effect-diagnostics nodeBuiltinImport:off - disposable native Linux CLI and Git integration.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { EVAL_INSTANCE, EVAL_MODEL, startEnvironment } from "./mobile-behavior/environment.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let nextId = 0;
const commandId = () => CommandId.make("command-" + ++nextId);
const threadId = () => ThreadId.make("thread-" + ++nextId);
const readRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: ThreadId,
      family: Schema.optional(Schema.Array(Schema.Struct({ threadId: ThreadId }))),
    }),
  ),
);
const modelSelection = { instanceId: EVAL_INSTANCE, model: EVAL_MODEL };
const scenarios = [
  "parent",
  "child",
  "concurrent",
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

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codeship-family-"));
      yield* Effect.logInfo("Disposable fixture", baseDir);
      const env = yield* startEnvironment({ baseDir, deviceHost: "127.0.0.1" });
      const { workspace, projectId } = env;
      const client = env.releaseClient();
      const base = git(workspace, "branch", "--show-current");
      NodeFS.appendFileSync(NodePath.join(workspace, ".git/info/exclude"), "\nlocal-proof.env\n");
      const dispatch = client["orchestration.dispatchCommand"];
      const fork = (sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
        dispatch({
          type: "thread.fork",
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          title: "Side chat",
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
          commandId: commandId(),
        });
      const settle = Effect.fn("proof.settle")(function* (
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
        yield* dispatch({
          type: "thread.settle",
          threadId: projection.thread.id,
          commandId: commandId(),
        });
      });
      const issue = (projection: OrchestrationV2ThreadProjection) =>
        NodeChildProcess.execFileSync(
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
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );

      const fixtures: {
        scenario: Scenario;
        root: ThreadId;
        child: ThreadId;
        checkout: string;
        branch: string;
        file: string;
      }[] = [];
      for (const scenario of scenarios) {
        const root = threadId();
        let child = threadId();
        const branch = "proof-" + scenario;
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
            text: scenario === "undelivered" ? "[[eval:hold:parent]]" : "first",
            attachments: [],
          },
        });
        const parent =
          scenario === "undelivered"
            ? yield* env.until("a running parent", root, (p) =>
                p.runs.at(-1)?.status === "running" && p.runs.at(-1)?.rootNodeId ? p : undefined,
              )
            : yield* env.settled(root);
        const checkout = parent.thread.worktreePath;
        NodeAssert.ok(checkout);
        if (scenario === "undelivered") {
          const run = parent.runs.at(-1)!;
          yield* dispatch({
            type: "delegated_task.request",
            parentThreadId: root,
            parentRunId: run.id,
            parentNodeId: run.rootNodeId!,
            task: "Return a result",
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
        } else if (scenario !== "singleton") {
          NodeAssert.equal(parent.runs.at(-1)?.status, "completed");
          yield* fork(root, child);
          yield* env.send(child, scenario === "failed" ? "[[eval:fail]]" : "child");
        }
        if (scenario !== "singleton") {
          const member = yield* env.settled(child);
          NodeAssert.equal(member.thread.worktreePath, checkout);
          NodeAssert.equal(member.thread.branch, branch);
          NodeAssert.equal(
            member.runs.at(-1)?.status,
            scenario === "failed" ? "failed" : "completed",
          );
          if (scenario === "parent")
            NodeAssert.throws(() => issue(member), { stdout: /Only the root/ });
          if (scenario === "undelivered") {
            const task = (yield* env.projection(root)).subagents.find(
              (item) => item.childThreadId === child,
            );
            NodeAssert.ok(task);
            NodeAssert.ok(
              !["acknowledged", "delivered"].includes(task.completionDelivery?.state ?? ""),
            );
          } else yield* settle(member);
        }
        if (scenario !== "undelivered") yield* settle(parent);
        const file = issue(parent)
          .match(/Queued worktree release in (.+)/)?.[1]
          ?.trim();
        NodeAssert.ok(file);
        const request = readRequest(NodeFS.readFileSync(file, "utf8"));
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
        fixtures.push({ scenario, root, child, checkout, branch, file });
      }

      // The production worker gives settlement scripts a minute to start a terminal.
      yield* Effect.sleep("65 seconds");
      const report = yield* client["server.runStorageCleanup"]({});
      git(
        workspace,
        "-c",
        "user.name=proof",
        "-c",
        "user.email=proof@example.org",
        "commit",
        "--allow-empty",
        "-m",
        "new base",
      );
      const tip = git(workspace, "rev-parse", "HEAD");
      for (const f of fixtures) {
        const removed = ["parent", "child", "singleton", "interrupted", "concurrent"].includes(
          f.scenario,
        );
        const reason = report.entries.find((entry) => entry.path === f.checkout)?.reason;
        NodeAssert.equal(NodeFS.existsSync(f.file + ".released"), removed, reason);
        NodeAssert.equal(NodeFS.existsSync(f.checkout), !removed, reason);
        NodeAssert.equal(
          git(workspace, "worktree", "list", "--porcelain").includes(
            "worktree " + f.checkout + "\n",
          ),
          !removed,
          reason,
        );
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
        NodeAssert.equal(receipt.threadId, f.root);
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
        const ids =
          f.scenario === "singleton"
            ? [f.root]
            : f.scenario === "child"
              ? [f.child, f.root]
              : [f.root, f.child];
        yield* Effect.forEach(
          ids,
          (id) =>
            Effect.gen(function* () {
              yield* env.send(id, "Continue");
              const result = yield* env.settled(id);
              NodeAssert.equal(result.runs.at(-1)?.status, "completed");
              NodeAssert.equal(git(f.checkout, "rev-parse", "HEAD"), tip);
              NodeAssert.equal(git(f.checkout, "branch", "--show-current"), f.branch);
            }),
          { concurrency: f.scenario === "concurrent" ? 2 : 1 },
        );
        NodeAssert.ok(!NodeFS.existsSync(f.file + ".restoring"));
        yield* Effect.logInfo(f.scenario, "released and resumed", tip);
      }
      yield* env.release("parent");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
