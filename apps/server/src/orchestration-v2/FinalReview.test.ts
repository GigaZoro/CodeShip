import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import { finalReviewCommand } from "./FinalReview.ts";

const threadId = ThreadId.make("thread:final-review");
const runId = RunId.make("run:final-review");
const rootNodeId = NodeId.make("node:final-review");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude_work");

const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  displayName: string,
  model: string,
) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    displayName,
    models: [{ slug: model, name: model.toUpperCase(), isCustom: false, capabilities: null }],
  }) as unknown as ServerProvider;

const providers = [
  provider(codex, "codex", "Codex", "gpt-6-astra"),
  provider(claude, "claudeAgent", "Claude work", "claude-opus-5-5"),
];

const settings: typeof DEFAULT_SERVER_SETTINGS = {
  ...DEFAULT_SERVER_SETTINGS,
  finalReviewModelSelections: [
    { instanceId: codex, model: "gpt-6-astra", autoAccount: true },
    { instanceId: claude, model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
  ],
  finalReviewInstructions: "Check tenant boundaries.",
};

const checkpoint = (id: string, ref: string, files: ReadonlyArray<string>, parent?: string) => ({
  id: CheckpointId.make(id),
  runId,
  nodeId: rootNodeId,
  parentCheckpointId: parent === undefined ? null : CheckpointId.make(parent),
  ordinalWithinScope: parent === undefined ? 0 : 1,
  ref: CheckpointRef.make(ref),
  status: "ready",
  files: files.map((path) => ({ path })),
});

const projection = (
  overrides: {
    readonly thread?: Record<string, unknown>;
    readonly run?: Record<string, unknown>;
    readonly message?: Record<string, unknown>;
    readonly files?: ReadonlyArray<string>;
  } = {},
) =>
  ({
    thread: {
      id: threadId,
      archivedAt: null,
      finalReview: true,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      ...overrides.thread,
    },
    runs: [
      {
        id: runId,
        status: "completed",
        rootNodeId,
        userMessageId: MessageId.make("message:request"),
        ...overrides.run,
      },
    ],
    messages: [
      {
        id: MessageId.make("message:request"),
        createdBy: "user",
        creationSource: "web",
        ...overrides.message,
      },
    ],
    checkpoints: [
      checkpoint("checkpoint:before", "refs/t3/before", []),
      checkpoint(
        "checkpoint:after",
        "refs/t3/after",
        overrides.files ?? ["src/a.ts"],
        "checkpoint:before",
      ),
    ],
  }) as unknown as Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "checkpoints"
  >;

const review = (overrides: Parameters<typeof projection>[0] = {}, reviewSettings = settings) =>
  finalReviewCommand({
    projection: projection(overrides),
    runId,
    settings: reviewSettings,
    providers,
  });

describe("finalReviewCommand", () => {
  it("asks the agent to have each reviewer check the turn's changes once", () => {
    const command = review();
    assert.strictEqual(command?.commandId, `final-review:${threadId}:${runId}`);
    assert.deepEqual(command?.dispatchMode, { type: "queue_after_active" });
    assert.strictEqual(command?.creationSource, "server");
    const text = command?.text ?? "";
    assert.include(
      text,
      `GPT-6-ASTRA (Codex): {"providerInstanceId":"codex","model":"gpt-6-astra"}`,
    );
    assert.include(
      text,
      `CLAUDE-OPUS-5-5 (Claude work): {"providerInstanceId":"claude_work","model":"claude-opus-5-5","options":{"effort":"high"}}`,
    );
    assert.include(text, "`git diff refs/t3/before refs/t3/after` (1 file: src/a.ts)");
    assert.include(text, "Project review instructions:\nCheck tenant boundaries.");
  });

  it("follows the default when the thread has no choice of its own", () => {
    const unset = { thread: { finalReview: undefined } };
    assert.isNull(review(unset));
    assert.isNotNull(review(unset, { ...settings, finalReviewByDefault: true }));
  });

  it.each([
    ["no reviewers are set", {}, { ...settings, finalReviewModelSelections: [] }],
    ["the thread turned it off", { thread: { finalReview: false } }, settings],
    ["the turn failed", { run: { status: "failed" } }, settings],
    ["the turn changed no files", { files: [] }, settings],
    // The review's own turn and task wake-ups come from the server, so they never chain.
    ["the server sent the message", { message: { creationSource: "server" } }, settings],
    ["an agent sent the message", { message: { createdBy: "agent" } }, settings],
    [
      "the thread is a subagent",
      {
        thread: {
          lineage: {
            parentThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("thread:parent"),
          },
        },
      },
      settings,
    ],
  ] as const)("starts no review when %s", (_, overrides, reviewSettings) => {
    assert.isNull(review(overrides, reviewSettings));
  });
});
