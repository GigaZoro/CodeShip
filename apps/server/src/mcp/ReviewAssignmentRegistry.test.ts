import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ReviewMaterialReceipt } from "@t3tools/contracts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ReviewAssignmentRegistry from "./ReviewAssignmentRegistry.ts";

const handle = "assignment-1";
const threadId = ThreadId.make("thread-review");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const pin = { handle, side: "head", path: "src/app.ts" } as const;
const digest = McpProviderSession.reviewEvidenceDigest("x");
const readTool = `${McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER}/${McpProviderSession.REVIEW_ASSIGNMENT_TOOL}`;

const openReviewWith = Effect.fn(function* (
  recordSession?: ReviewAssignmentRegistry.ReviewAssignmentBroker["recordSession"],
) {
  const registry = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
  const receipts: Array<ReviewMaterialReceipt> = [];
  yield* registry.register({
    handle,
    allowedReads: [pin],
    read: async () => new TextEncoder().encode("const answer = 42;\n"),
    record: async (receipt) => {
      receipts.push(receipt);
    },
    ...(recordSession === undefined ? {} : { recordSession }),
  });
  const session = yield* registry.openSession({ threadId, handle, providerInstanceId });
  const evidence: McpProviderSession.ReviewAssignmentSessionEvidence = {
    runId: "run-1",
    driver: "claudeAgent",
    nativeAccount: digest,
    model: "claude-sonnet-4-6",
    effort: "high",
    effectiveTools: [readTool],
    mcpServers: [McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER],
    cwd: session.cwd,
    instructionDigest: digest,
    promptDigest: digest,
  };
  return { registry, session, evidence, receipts };
});
const openReview = openReviewWith();

const registryLayer = ReviewAssignmentRegistry.layer.pipe(Layer.provide(NodeServices.layer));

it.effect("serves no material until the session is attested, then records each read", () =>
  Effect.gen(function* () {
    const { registry, session, evidence, receipts } = yield* openReview;
    const caller = { threadId, handle };

    const beforeAttest = yield* registry.readMaterial(caller, pin).pipe(Effect.flip);
    yield* session.attest(evidence);
    const text = yield* registry.readMaterial(caller, pin);
    const outsidePin = yield* registry
      .readMaterial(caller, { ...pin, path: "src/secret.ts" })
      .pipe(Effect.flip);

    assert.equal(beforeAttest._tag, "ReviewMaterialUnavailableError");
    assert.equal(text, "const answer = 42;\n");
    assert.equal(outsidePin._tag, "ReviewMaterialUnavailableError");
    assert.deepEqual(
      receipts.map((receipt) => receipt.runId),
      ["run-1"],
    );
    assert.deepEqual((yield* registry.evidence(threadId))?.sessions[0]?.effectiveTools, [readTool]);
  }).pipe(Effect.provide(registryLayer)),
);

it.effect.each([
  ["a built-in tool", { effectiveTools: ["Bash", readTool] }],
  [
    "another MCP server",
    { mcpServers: ["t3-code", McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER] },
  ],
  ["a checkout as its working directory", { cwd: "/workspace" }],
  ["an account it did not digest", { nativeAccount: "reviewer@example.com" }],
  ["no model", { model: "" }],
] as const)("refuses a session that reports %s, and keeps refusing reads", ([, change]) =>
  Effect.gen(function* () {
    const { registry, session, evidence } = yield* openReview;

    const refusal = yield* session.attest({ ...evidence, ...change }).pipe(Effect.flip);
    const read = yield* registry.readMaterial({ threadId, handle }, pin).pipe(Effect.flip);

    assert.equal(refusal._tag, "ReviewAssignmentRefusedError");
    assert.equal(read._tag, "ReviewMaterialUnavailableError");
    assert.deepEqual((yield* registry.evidence(threadId))?.sessions, []);
  }).pipe(Effect.provide(registryLayer)),
);

it.effect("refuses to attest a session the thread has since replaced", () =>
  Effect.gen(function* () {
    const { registry, session, evidence } = yield* openReview;
    const replacement = yield* registry.openSession({ threadId, handle, providerInstanceId });

    const refusal = yield* session.attest(evidence).pipe(Effect.flip);

    assert.equal(refusal.reason, "the restricted session was closed");
    assert.equal(replacement.cwd, session.cwd);
  }).pipe(Effect.provide(registryLayer)),
);

it.effect("arms no reads and keeps no session when the assignment cannot record it", () =>
  Effect.gen(function* () {
    const { registry, session, evidence } = yield* openReviewWith(async () => {
      throw new Error("assignment store unavailable");
    });

    const refusal = yield* session.attest(evidence).pipe(Effect.flip);
    const read = yield* registry.readMaterial({ threadId, handle }, pin).pipe(Effect.flip);

    assert.equal(refusal.reason, "the assignment could not record the session");
    assert.equal(read._tag, "ReviewMaterialUnavailableError");
    assert.deepEqual((yield* registry.evidence(threadId))?.sessions, []);
  }).pipe(Effect.provide(registryLayer)),
);

it.effect.each([
  [
    "closed",
    (registry: ReviewAssignmentRegistry.ReviewAssignmentRegistry["Service"]) =>
      registry.closeSession(threadId),
  ],
  [
    "unregistered",
    (registry: ReviewAssignmentRegistry.ReviewAssignmentRegistry["Service"]) =>
      registry.unregister(handle),
  ],
] as const)("refuses a session %s while the assignment records it", ([, end]) =>
  Effect.gen(function* () {
    let started!: () => void;
    const recording = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { registry, session, evidence } = yield* openReviewWith(async () => {
      started();
      await released;
    });

    const attesting = yield* session.attest(evidence).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => recording);
    yield* end(registry);
    release();
    const refusal = yield* Fiber.join(attesting);

    assert.equal(refusal._tag, "ReviewAssignmentRefusedError");
    assert.deepEqual((yield* registry.evidence(threadId))?.sessions, []);
    assert.equal(
      (yield* registry.readMaterial({ threadId, handle }, pin).pipe(Effect.flip))._tag,
      "ReviewMaterialUnavailableError",
    );
  }).pipe(Effect.provide(registryLayer)),
);

it.effect("disarms reads when a later run of the session fails its check", () =>
  Effect.gen(function* () {
    const { registry, session, evidence } = yield* openReview;
    yield* session.attest(evidence);

    const refusal = yield* session
      .attest({ ...evidence, runId: "run-2", effectiveTools: ["Bash", readTool] })
      .pipe(Effect.flip);
    const read = yield* registry.readMaterial({ threadId, handle }, pin).pipe(Effect.flip);

    assert.equal(refusal._tag, "ReviewAssignmentRefusedError");
    assert.equal(read._tag, "ReviewMaterialUnavailableError");
  }).pipe(Effect.provide(registryLayer)),
);
