import {
  type ProviderInstanceId,
  ReviewMaterialRead,
  type ReviewMaterialReceipt,
  ReviewSessionEvidence,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { bindReviewMaterial } from "@t3tools/provider-core/server/reviewMaterial";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous, filename-safe name for a thread's workspace.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** One assignment's read broker. Its pins are the only bytes a restricted reviewer can reach. */
export interface ReviewAssignmentBroker {
  readonly handle: string;
  readonly allowedReads: ReadonlyArray<ReviewMaterialRead>;
  readonly read: (request: ReviewMaterialRead) => Promise<Uint8Array>;
  readonly record: (receipt: ReviewMaterialReceipt) => Promise<void>;
  readonly recordSession?: (evidence: ReviewSessionEvidence) => Promise<void>;
}

export interface ReviewAssignmentEvidence {
  readonly sessions: ReadonlyArray<ReviewSessionEvidence>;
  readonly receipts: ReadonlyArray<ReviewMaterialReceipt>;
}

export class ReviewAssignmentRegistrationError extends Schema.TaggedError<ReviewAssignmentRegistrationError>()(
  "ReviewAssignmentRegistrationError",
  { reason: Schema.Literals(["duplicate_handle", "invalid_pins", "foreign_pin"]) },
) {
  override get message() {
    return `Review assignment registration refused: ${this.reason}.`;
  }
}

export class ReviewMaterialUnavailableError extends Schema.TaggedError<ReviewMaterialUnavailableError>()(
  "ReviewMaterialUnavailableError",
  {},
) {
  override get message() {
    return "Material read unavailable.";
  }
}

/**
 * Only these adapters verify every model input and tool before inference. Codex is absent: its
 * app-server (0.172) reports no thread's effective tools, skills or feature state before the first
 * prompt, so it cannot prove a review's isolation.
 */
export const RESTRICTED_REVIEW_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);
export const RESTRICTED_REVIEW_RUNTIME_MODE = "approval-required" satisfies RuntimeMode;
const RESTRICTED_REVIEW_TOOLS: ReadonlyArray<string> = [
  `${McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER}/${McpProviderSession.REVIEW_ASSIGNMENT_TOOL}`,
];
const RESTRICTED_REVIEW_SERVERS: ReadonlyArray<string> = [
  McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER,
];
// Evidence outlives the child's provider session so task_status can still report it.
const MAX_RETAINED_THREADS = 256;

const decodeRead = Schema.decodeUnknownOption(ReviewMaterialRead, { onExcessProperty: "error" });
const decodeEvidence = Schema.decodeUnknownOption(ReviewSessionEvidence);
const isSha256 = (value: string) => /^[0-9a-f]{64}$/.test(value);
const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

interface OpenSession {
  readonly handle: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  /** Reads are refused until a run of this session passes its pre-inference check. */
  attestedRunId: RunId | undefined;
}

interface ThreadRecord {
  readonly sessions: Array<ReviewSessionEvidence>;
  readonly receipts: Array<ReviewMaterialReceipt>;
}

export class ReviewAssignmentRegistry extends Context.Service<
  ReviewAssignmentRegistry,
  {
    readonly register: (
      broker: ReviewAssignmentBroker,
    ) => Effect.Effect<void, ReviewAssignmentRegistrationError>;
    readonly unregister: (handle: string) => Effect.Effect<void>;
    readonly isRegistered: (handle: string) => Effect.Effect<boolean>;
    /** A fresh, empty working directory and the attestation callback for one restricted thread. */
    readonly openSession: (input: {
      readonly threadId: ThreadId;
      readonly handle: string;
      readonly providerInstanceId: ProviderInstanceId;
    }) => Effect.Effect<
      McpProviderSession.ReviewAssignmentSession,
      McpProviderSession.ReviewAssignmentRefusedError
    >;
    readonly closeSession: (threadId: ThreadId) => Effect.Effect<void>;
    readonly readMaterial: (
      caller: { readonly threadId: ThreadId; readonly handle: string },
      input: unknown,
    ) => Effect.Effect<string, ReviewMaterialUnavailableError>;
    readonly evidence: (threadId: ThreadId) => Effect.Effect<ReviewAssignmentEvidence | undefined>;
  }
>()("t3/mcp/ReviewAssignmentRegistry") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const brokers = new Map<string, ReviewAssignmentBroker>();
  const sessions = new Map<ThreadId, OpenSession>();
  const records = new Map<ThreadId, ThreadRecord>();

  const recordFor = (threadId: ThreadId): ThreadRecord => {
    const existing = records.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadRecord = { sessions: [], receipts: [] };
    records.set(threadId, created);
    while (records.size > MAX_RETAINED_THREADS) {
      const oldest = records.keys().next().value;
      if (oldest === undefined || sessions.has(oldest)) break;
      records.delete(oldest);
    }
    return created;
  };

  const removeWorkspace = (cwd: string) =>
    fileSystem.remove(cwd, { recursive: true, force: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.logWarning("could not remove a restricted review workspace", { cause }),
      }),
    );

  // One private root, made on first use so a failure refuses reviews instead of server startup.
  let root: string | undefined;
  const rootLock = yield* Semaphore.make(1);
  const workspaceRoot = rootLock.withPermits(1)(
    Effect.gen(function* () {
      if (root !== undefined) return root;
      const created = yield* fileSystem.makeTempDirectory({ prefix: "t3-review-" });
      // Providers report canonical paths (macOS /var is /private/var), so compare against that.
      root = yield* fileSystem.realPath(created);
      return root;
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      sessions.clear();
      return root === undefined ? Effect.void : removeWorkspace(root);
    }),
  );

  const register = Effect.fn("ReviewAssignmentRegistry.register")(function* (
    broker: ReviewAssignmentBroker,
  ) {
    if (brokers.has(broker.handle)) {
      return yield* new ReviewAssignmentRegistrationError({ reason: "duplicate_handle" });
    }
    const pins = broker.allowedReads.map((pin) => decodeRead(pin));
    if (pins.length === 0 || pins.some((pin) => pin._tag === "None")) {
      return yield* new ReviewAssignmentRegistrationError({ reason: "invalid_pins" });
    }
    // bindReviewMaterial matches pins exactly; a pin under another handle would leak that assignment.
    if (pins.some((pin) => pin._tag === "Some" && pin.value.handle !== broker.handle)) {
      return yield* new ReviewAssignmentRegistrationError({ reason: "foreign_pin" });
    }
    brokers.set(broker.handle, broker);
  });

  const unregister = Effect.fn("ReviewAssignmentRegistry.unregister")((handle: string) =>
    Effect.sync(() => {
      brokers.delete(handle);
    }),
  );

  const openSession = Effect.fn("ReviewAssignmentRegistry.openSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly handle: string;
    readonly providerInstanceId: ProviderInstanceId;
  }) {
    if (!brokers.has(input.handle)) {
      return yield* new McpProviderSession.ReviewAssignmentRefusedError({
        reason: "the assignment is not registered",
      });
    }
    sessions.delete(input.threadId);
    // The same path for every session of a thread, so a provider can resume its own transcript.
    // Uninterruptible, so a workspace on disk always has the session closeSession removes it by.
    const session = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const base = yield* workspaceRoot;
        const workspace = path.join(
          base,
          NodeCrypto.createHash("sha256").update(input.threadId).digest("hex"),
        );
        yield* fileSystem.remove(workspace, { recursive: true, force: true });
        yield* fileSystem.makeDirectory(workspace);
        const opened: OpenSession = {
          handle: input.handle,
          providerInstanceId: input.providerInstanceId,
          cwd: workspace,
          attestedRunId: undefined,
        };
        sessions.set(input.threadId, opened);
        recordFor(input.threadId);
        return opened;
      }).pipe(
        Effect.mapError(
          () =>
            new McpProviderSession.ReviewAssignmentRefusedError({
              reason: "could not create an isolated workspace",
            }),
        ),
      ),
    );

    const attest = Effect.fn("ReviewAssignmentRegistry.attest")(function* (
      evidence: McpProviderSession.ReviewAssignmentSessionEvidence,
    ) {
      const refuse = (reason: string) =>
        Effect.fail(new McpProviderSession.ReviewAssignmentRefusedError({ reason }));
      // A new run disarms reads until it passes, so a failed check never inherits an earlier pass.
      session.attestedRunId = undefined;
      if (sessions.get(input.threadId) !== session) {
        return yield* refuse("the restricted session was closed");
      }
      if (!brokers.has(session.handle)) return yield* refuse("the assignment is not registered");
      if (evidence.cwd !== session.cwd)
        return yield* refuse("the working directory is not isolated");
      if (!sameList(evidence.effectiveTools, RESTRICTED_REVIEW_TOOLS)) {
        return yield* refuse("tools other than read_material are available");
      }
      if (!sameList(evidence.mcpServers, RESTRICTED_REVIEW_SERVERS)) {
        return yield* refuse("MCP servers other than the assignment are connected");
      }
      if (
        !isSha256(evidence.nativeAccount) ||
        !isSha256(evidence.instructionDigest) ||
        !isSha256(evidence.promptDigest)
      ) {
        return yield* refuse("the session evidence is incomplete");
      }
      const decoded = decodeEvidence({
        ...evidence,
        assignmentHandle: session.handle,
        providerInstanceId: session.providerInstanceId,
        verifiedBeforeInference: true,
      });
      if (decoded._tag === "None" || decoded.value.model.length === 0) {
        return yield* refuse("the session evidence is incomplete");
      }
      const verified = decoded.value;
      // The assignment's own record comes first: evidence and reads exist only for a session it holds.
      const recordSession = brokers.get(session.handle)?.recordSession;
      if (recordSession !== undefined) {
        yield* Effect.tryPromise(() => recordSession(verified)).pipe(
          Effect.catch(() => refuse("the assignment could not record the session")),
        );
      }
      // The session can close, or the assignment end, while its record is written.
      if (sessions.get(input.threadId) !== session || !brokers.has(session.handle)) {
        return yield* refuse("the restricted session was closed");
      }
      const record = recordFor(input.threadId);
      if (!record.sessions.some((entry) => entry.runId === verified.runId)) {
        record.sessions.push(verified);
      }
      session.attestedRunId = verified.runId;
      yield* Effect.logInfo("restricted review session verified before inference", {
        threadId: input.threadId,
        runId: verified.runId,
        driver: verified.driver,
        model: verified.model,
        effort: verified.effort,
        instructionDigest: verified.instructionDigest,
        promptDigest: verified.promptDigest,
      });
    });

    return {
      handle: input.handle,
      cwd: session.cwd,
      attest,
    } satisfies McpProviderSession.ReviewAssignmentSession;
  });

  const closeSession = Effect.fn("ReviewAssignmentRegistry.closeSession")(function* (
    threadId: ThreadId,
  ) {
    const session = sessions.get(threadId);
    if (session === undefined) return;
    sessions.delete(threadId);
    yield* removeWorkspace(session.cwd);
  });

  const readMaterial = Effect.fn("ReviewAssignmentRegistry.readMaterial")(function* (
    caller: { readonly threadId: ThreadId; readonly handle: string },
    input: unknown,
  ) {
    const session = sessions.get(caller.threadId);
    const broker = brokers.get(caller.handle);
    const runId = session?.attestedRunId;
    if (
      session === undefined ||
      session.handle !== caller.handle ||
      broker === undefined ||
      runId === undefined
    ) {
      return yield* new ReviewMaterialUnavailableError();
    }
    const record = recordFor(caller.threadId);
    const bound = bindReviewMaterial({
      allowedReads: broker.allowedReads,
      read: broker.read,
      record: async (request, served) => {
        const receipt: ReviewMaterialReceipt = {
          runId,
          handle: request.handle,
          ...(request.side === undefined ? {} : { side: request.side }),
          ...(request.path === undefined ? {} : { path: request.path }),
          byteLength: served.byteLength,
          sha256: served.sha256,
        };
        await broker.record(receipt);
        const repeated = record.receipts.some(
          (entry) =>
            entry.runId === receipt.runId &&
            entry.side === receipt.side &&
            entry.path === receipt.path &&
            entry.sha256 === receipt.sha256,
        );
        if (!repeated) record.receipts.push(Object.freeze(receipt));
      },
    });
    return yield* Effect.tryPromise(() => bound.read_material(input)).pipe(
      Effect.mapError(() => new ReviewMaterialUnavailableError()),
    );
  });

  const evidence = Effect.fn("ReviewAssignmentRegistry.evidence")((threadId: ThreadId) =>
    Effect.sync((): ReviewAssignmentEvidence | undefined => {
      const record = records.get(threadId);
      return record === undefined
        ? undefined
        : { sessions: [...record.sessions], receipts: [...record.receipts] };
    }),
  );

  const isRegistered = Effect.fn("ReviewAssignmentRegistry.isRegistered")((handle: string) =>
    Effect.sync(() => brokers.has(handle)),
  );

  return ReviewAssignmentRegistry.of({
    register,
    unregister,
    isRegistered,
    openSession,
    closeSession,
    readMaterial,
    evidence,
  });
});

export const layer = Layer.effect(ReviewAssignmentRegistry, make);
