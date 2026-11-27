import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ReviewMaterialReceipt } from "@t3tools/contracts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ReviewAssignmentRegistry from "./ReviewAssignmentRegistry.ts";

const handle = "assignment-1";
const threadId = ThreadId.make("thread-review");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const pin = { handle, side: "head", path: "src/app.ts" } as const;
const digest = McpProviderSession.reviewEvidenceDigest("x");
const readTool = `${McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER}/${McpProviderSession.REVIEW_ASSIGNMENT_TOOL}`;

const openReview = Effect.gen(function* () {
  const registry = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
  const receipts: Array<ReviewMaterialReceipt> = [];
  yield* registry.register({
    handle,
    allowedReads: [pin],
    read: async () => new TextEncoder().encode("const answer = 42;\n"),
    record: async (receipt) => {
      receipts.push(receipt);
    },
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
