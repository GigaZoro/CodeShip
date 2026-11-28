import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts/baseSchemas";
import type { ReviewMaterialReceipt } from "@t3tools/contracts/orchestratorMcp";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ReviewAssignmentRegistry from "./ReviewAssignmentRegistry.ts";

const handle = "assignment-1";
const owner = ThreadId.make("thread-evaluator");
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
    owner,
    allowedReads: [pin],
    read: async () => new TextEncoder().encode("const answer = 42;\n"),
    record: async (receipt) => {
      receipts.push(receipt);
    },
    ...(recordSession === undefined ? {} : { recordSession }),
  });
  const session = yield* registry.openSession({ threadId, handle, owner, providerInstanceId });
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

const registryLayer = ReviewAssignmentRegistry.layer.pipe(Layer.provideMerge(NodeServices.layer));

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
    const replacement = yield* registry.openSession({
      threadId,
      handle,
      owner,
      providerInstanceId,
    });

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
    "revoked",
    (registry: ReviewAssignmentRegistry.ReviewAssignmentRegistry["Service"]) =>
      registry.revoke({ owner, handle }),
  ],
  [
    "re-registered under its handle",
    (registry: ReviewAssignmentRegistry.ReviewAssignmentRegistry["Service"]) =>
      registry.revoke({ owner, handle }).pipe(
        Effect.andThen(
          registry.register({
            handle,
            owner,
            allowedReads: [pin],
            read: async () => new TextEncoder().encode("another assignment\n"),
            record: async () => undefined,
          }),
        ),
        Effect.orDie,
      ),
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

it.effect("refuses a session whose assignment is revoked while its workspace is made", () =>
  Effect.gen(function* () {
    let started!: () => void;
    const making = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fileSystem) => ({
        ...fileSystem,
        makeDirectory: (path, options) =>
          Effect.sync(started).pipe(
            Effect.andThen(Effect.promise(() => released)),
            Effect.andThen(fileSystem.makeDirectory(path, options)),
          ),
      })),
    );

    yield* Effect.gen(function* () {
      const registry = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
      yield* registry.register({
        handle,
        owner,
        allowedReads: [pin],
        read: async () => new TextEncoder().encode("const answer = 42;\n"),
        record: async () => undefined,
      });
      const opening = yield* registry
        .openSession({ threadId, handle, owner, providerInstanceId })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => making);
      yield* registry.revoke({ owner, handle });
      release();
      const refusal = yield* Fiber.join(opening);

      assert.equal(refusal.reason, "the assignment is not registered");
      assert.isUndefined(yield* registry.evidence(threadId));
    }).pipe(
      Effect.provide(
        ReviewAssignmentRegistry.layer.pipe(
          Layer.provide(gatedFileSystem),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }),
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

it.effect("stops serving an attested session once its handle is registered again", () =>
  Effect.gen(function* () {
    const { registry, session, evidence } = yield* openReview;
    yield* session.attest(evidence);

    yield* registry.revoke({ owner, handle });
    yield* registry.register({
      handle,
      owner: ThreadId.make("thread-other-evaluator"),
      allowedReads: [pin],
      read: async () => new TextEncoder().encode("another assignment\n"),
      record: async () => undefined,
    });
    const read = yield* registry.readMaterial({ threadId, handle }, pin).pipe(Effect.flip);

    assert.equal(read._tag, "ReviewMaterialUnavailableError");
  }).pipe(Effect.provide(registryLayer)),
);

it.effect("serves a snapshot of registered files under a new handle, owned by its thread", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-review-material-" });
    const file = `${directory}/app.ts`;
    yield* fileSystem.writeFileString(file, "const answer = 42;\n");
    const registry = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;

    const registered = yield* registry.registerFiles({
      owner,
      material: [{ side: "head", path: "src/app.ts", file }],
    });
    yield* fileSystem.writeFileString(file, "changed after registration\n");
    const stranger = ThreadId.make("thread-stranger");
    const ownedElsewhere = yield* registry.isRegistered({
      owner: stranger,
      handle: registered.handle,
    });
    const revokedByStranger = yield* registry.revoke({
      owner: stranger,
      handle: registered.handle,
    });
    const openedByStranger = yield* registry
      .openSession({ threadId, handle: registered.handle, owner: stranger, providerInstanceId })
      .pipe(Effect.flip);
    const session = yield* registry.openSession({
      threadId,
      handle: registered.handle,
      owner,
      providerInstanceId,
    });
    yield* session.attest({
      runId: "run-1",
      driver: "claudeAgent",
      nativeAccount: digest,
      model: "claude-haiku-4-5",
      effort: null,
      effectiveTools: [readTool],
      mcpServers: [McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER],
      cwd: session.cwd,
      instructionDigest: digest,
      promptDigest: digest,
    });
    const filePin = { handle: registered.handle, side: "head", path: "src/app.ts" };
    const text = yield* registry.readMaterial({ threadId, handle: registered.handle }, filePin);
    const revoked = yield* registry.revoke({ owner, handle: registered.handle });
    const revokedAgain = yield* registry.revoke({ owner, handle: registered.handle });
    const afterRevoke = yield* registry
      .readMaterial({ threadId, handle: registered.handle }, filePin)
      .pipe(Effect.flip);

    assert.match(registered.handle, /^ra-[A-Za-z0-9_-]{22}$/);
    assert.equal(text, "const answer = 42;\n");
    assert.deepEqual(registered.material, [
      {
        side: "head",
        path: "src/app.ts",
        byteLength: 19,
        sha256: "8691f74ea796569734dafffbbcb79088362b52c3cef154aa0d8f32696d2d4737",
      },
    ]);
    assert.deepEqual(
      (yield* registry.evidence(threadId))?.receipts.map((receipt) => receipt.sha256),
      [registered.material[0]?.sha256],
    );
    assert.deepEqual([ownedElsewhere, revokedByStranger], [false, false]);
    assert.equal(openedByStranger.reason, "the assignment is not registered");
    assert.deepEqual([revoked, revokedAgain], [true, false]);
    assert.equal(afterRevoke._tag, "ReviewMaterialUnavailableError");
  }).pipe(Effect.provide(registryLayer)),
);

it.effect.each([
  ["a relative path", "relative.ts", "unreadable_material"],
  ["a directory", ".", "unreadable_material"],
  ["a missing file", "missing.ts", "unreadable_material"],
  ["bytes that are not UTF-8", "binary.bin", "unreadable_material"],
  ["more bytes than an assignment holds", "large.txt", "too_large"],
  ["a side and path twice", "app.ts", "invalid_pins"],
] as const)("refuses to register %s", ([, name, reason]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-review-material-" });
    yield* fileSystem.writeFileString(`${directory}/app.ts`, "const answer = 42;\n");
    yield* fileSystem.writeFile(`${directory}/binary.bin`, new Uint8Array([0xff, 0xfe, 0x00]));
    yield* fileSystem.writeFileString(`${directory}/large.txt`, "");
    yield* fileSystem.truncate(`${directory}/large.txt`, 8 * 1024 * 1024 + 1);
    const file = name === "relative.ts" ? name : name === "." ? directory : `${directory}/${name}`;
    const registry = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;

    const refusal = yield* registry
      .registerFiles({
        owner,
        material: [
          { side: "head", path: "src/app.ts", file: `${directory}/app.ts` },
          { side: name === "app.ts" ? "head" : "base", path: "src/app.ts", file },
        ],
      })
      .pipe(Effect.flip);

    assert.equal(refusal.reason, reason);
    assert.include(refusal.message, "material[1]");
  }).pipe(Effect.provide(registryLayer)),
);

it.effect("drops the oldest idle assignment, never one a session reads, when it is full", () =>
  Effect.gen(function* () {
    const registry = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
    const registerNumbered = (index: number) =>
      registry.register({
        handle: `assignment-${index}`,
        owner,
        allowedReads: [{ handle: `assignment-${index}` }],
        read: async () => new Uint8Array(),
        record: async () => undefined,
      });
    for (let index = 0; index < 256; index += 1) yield* registerNumbered(index);
    yield* registry.openSession({ threadId, handle: "assignment-0", owner, providerInstanceId });

    yield* registerNumbered(256);
    const held = yield* Effect.forEach([0, 1, 2, 256], (index) =>
      registry.isRegistered({ owner, handle: `assignment-${index}` }),
    );

    assert.deepEqual(held, [true, false, true, true]);
  }).pipe(Effect.provide(registryLayer)),
);
