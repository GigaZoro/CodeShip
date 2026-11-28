import type { RunId, ThreadId } from "@t3tools/contracts/baseSchemas";
import {
  ReviewMaterialRead,
  type ReviewMaterialReceipt,
  ReviewSessionEvidence,
} from "@t3tools/contracts/orchestratorMcp";
import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { RuntimeMode } from "@t3tools/contracts/providerPolicy";
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
import * as Stream from "effect/Stream";

/** One assignment's read broker. Its pins are the only bytes a restricted reviewer can reach. */
export interface ReviewAssignmentBroker {
  readonly handle: string;
  /** The thread that registered it: only that thread can delegate a review of it or revoke it. */
  readonly owner: ThreadId;
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
  {
    reason: Schema.Literals([
      "duplicate_handle",
      "invalid_pins",
      "foreign_pin",
      "unreadable_material",
      "too_large",
      "registry_full",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return `Review assignment registration refused: ${this.reason}${this.detail === undefined ? "" : ` (${this.detail})`}.`;
  }
}

/** A file `registerFiles` snapshotted, as the reviewer reads it and as its receipts will show it. */
export interface ReviewAssignmentSnapshot {
  readonly side?: string;
  readonly path?: string;
  readonly byteLength: number;
  readonly sha256: string;
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
// Registrations live until revoked or a restart; past these, the oldest without an open session go.
const MAX_REGISTRATIONS = 256;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_ASSIGNMENT_BYTES = 8 * 1024 * 1024;

const decodeRead = Schema.decodeUnknownOption(ReviewMaterialRead, { onExcessProperty: "error" });
const decodeEvidence = Schema.decodeUnknownOption(ReviewSessionEvidence);
const isSha256 = (value: string) => /^[0-9a-f]{64}$/.test(value);
const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);
const pinKey = (pin: { readonly side?: string; readonly path?: string }) =>
  JSON.stringify([pin.side ?? null, pin.path ?? null]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isUtf8 = (bytes: Uint8Array) => {
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

interface Registration {
  readonly broker: ReviewAssignmentBroker;
  /** Bytes held in memory for a snapshot; zero for a broker that reads elsewhere. */
  readonly bytes: number;
}

interface OpenSession {
  readonly handle: string;
  /** The registration it opened against: a revoked or replaced one serves and attests nothing. */
  readonly broker: ReviewAssignmentBroker;
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
    /** Reads each file once, now, and registers the bytes under a new, unguessable handle. */
    readonly registerFiles: (input: {
      readonly owner: ThreadId;
      readonly material: ReadonlyArray<{
        readonly side?: string;
        readonly path?: string;
        readonly file: string;
      }>;
    }) => Effect.Effect<
      { readonly handle: string; readonly material: ReadonlyArray<ReviewAssignmentSnapshot> },
      ReviewAssignmentRegistrationError
    >;
    /** Whether `owner` held the registration, which is now gone. */
    readonly revoke: (input: {
      readonly owner: ThreadId;
      readonly handle: string;
    }) => Effect.Effect<boolean>;
    readonly isRegistered: (input: {
      readonly owner: ThreadId;
      readonly handle: string;
    }) => Effect.Effect<boolean>;
    /**
     * A fresh, empty working directory and the attestation callback for one restricted thread.
     * `owner` is the thread that delegated the review; only its own registration opens.
     */
    readonly openSession: (input: {
      readonly threadId: ThreadId;
      readonly handle: string;
      readonly owner: ThreadId;
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
  const registrations = new Map<string, Registration>();
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

  const currentBroker = (handle: string) => registrations.get(handle)?.broker;
  // A handle answers only to the thread that registered it.
  const ownedBroker = (input: { readonly owner: ThreadId; readonly handle: string }) => {
    const broker = currentBroker(input.handle);
    return broker?.owner === input.owner ? broker : undefined;
  };

  // Checks and inserts with no yield between them, so no other registration lands in between.
  const add = Effect.fn("ReviewAssignmentRegistry.add")(function* (
    broker: ReviewAssignmentBroker,
    bytes: number,
  ) {
    const refusal = (reason: ReviewAssignmentRegistrationError["reason"]) =>
      new ReviewAssignmentRegistrationError({ reason });
    if (registrations.has(broker.handle)) return yield* refusal("duplicate_handle");
    const pins = broker.allowedReads.map((pin) => decodeRead(pin));
    if (
      pins.length === 0 ||
      pins.some((pin) => pin._tag === "None") ||
      new Set(broker.allowedReads.map(pinKey)).size !== pins.length
    ) {
      return yield* refusal("invalid_pins");
    }
    // bindReviewMaterial matches pins exactly; a pin under another handle would leak that assignment.
    if (pins.some((pin) => pin._tag === "Some" && pin.value.handle !== broker.handle)) {
      return yield* refusal("foreign_pin");
    }
    let count = registrations.size + 1;
    let held = bytes;
    for (const registration of registrations.values()) held += registration.bytes;
    const dropped: Array<string> = [];
    // Oldest first; an assignment a session still reads stays.
    for (const [handle, registration] of registrations) {
      if (count <= MAX_REGISTRATIONS && held <= MAX_SNAPSHOT_BYTES) break;
      if ([...sessions.values()].some((session) => session.broker === registration.broker)) {
        continue;
      }
      dropped.push(handle);
      count -= 1;
      held -= registration.bytes;
    }
    if (count > MAX_REGISTRATIONS || held > MAX_SNAPSHOT_BYTES) {
      return yield* refusal("registry_full");
    }
    for (const handle of dropped) registrations.delete(handle);
    registrations.set(broker.handle, { broker, bytes });
    if (dropped.length > 0) {
      yield* Effect.logWarning("dropped the oldest idle review assignments to make room", {
        dropped: dropped.length,
      });
    }
  });

  const register = Effect.fn("ReviewAssignmentRegistry.register")(
    (broker: ReviewAssignmentBroker) => add(broker, 0),
  );

  const registerFiles = Effect.fn("ReviewAssignmentRegistry.registerFiles")(function* (input: {
    readonly owner: ThreadId;
    readonly material: ReadonlyArray<{
      readonly side?: string;
      readonly path?: string;
      readonly file: string;
    }>;
  }) {
    const handle = `ra-${NodeCrypto.randomBytes(16).toString("base64url")}`;
    const contents = new Map<string, Uint8Array>();
    const pins: Array<{ readonly side?: string; readonly path?: string }> = [];
    const snapshots: Array<ReviewAssignmentSnapshot> = [];
    let total = 0;
    for (const [index, entry] of input.material.entries()) {
      const refuse = (reason: ReviewAssignmentRegistrationError["reason"], detail: string) =>
        new ReviewAssignmentRegistrationError({ reason, detail: `material[${index}]: ${detail}` });
      const pin = {
        ...(entry.side === undefined ? {} : { side: entry.side }),
        ...(entry.path === undefined ? {} : { path: entry.path }),
      };
      if (contents.has(pinKey(pin))) {
        return yield* refuse("invalid_pins", "repeats an earlier side and path");
      }
      if (!path.isAbsolute(entry.file)) {
        return yield* refuse("unreadable_material", "file is not an absolute path");
      }
      const unreadable = () => refuse("unreadable_material", "file cannot be read");
      const info = yield* fileSystem.stat(entry.file).pipe(Effect.mapError(unreadable));
      if (info.type !== "File") {
        return yield* refuse("unreadable_material", "file is not a regular file");
      }
      const tooLarge = refuse(
        "too_large",
        `an assignment holds at most ${MAX_ASSIGNMENT_BYTES} bytes`,
      );
      if (total + Number(info.size) > MAX_ASSIGNMENT_BYTES) return yield* tooLarge;
      // One byte past the room left, so a file that grew since stat, or one whose size stat does
      // not report, refuses without being read whole.
      const bytes = yield* Stream.mkUint8Array(
        fileSystem.stream(entry.file, { bytesToRead: MAX_ASSIGNMENT_BYTES - total + 1 }),
      ).pipe(Effect.mapError(unreadable));
      total += bytes.byteLength;
      if (total > MAX_ASSIGNMENT_BYTES) return yield* tooLarge;
      if (!isUtf8(bytes)) return yield* refuse("unreadable_material", "file is not UTF-8 text");
      contents.set(pinKey(pin), bytes);
      pins.push(pin);
      snapshots.push({
        ...pin,
        byteLength: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
    yield* add(
      {
        handle,
        owner: input.owner,
        allowedReads: pins.map((pin) => ({ handle, ...pin })),
        read: async (request) => {
          const bytes = contents.get(pinKey(request));
          if (bytes === undefined) throw new Error("Read outside assignment.");
          return bytes;
        },
        // The registry keeps every receipt for task_status; the snapshot has nowhere else to put one.
        record: async () => undefined,
      },
      total,
    );
    return { handle, material: snapshots };
  });

  const revoke = Effect.fn("ReviewAssignmentRegistry.revoke")(
    (input: { readonly owner: ThreadId; readonly handle: string }) =>
      Effect.sync(() => {
        if (ownedBroker(input) === undefined) return false;
        registrations.delete(input.handle);
        return true;
      }),
  );

  const openSession = Effect.fn("ReviewAssignmentRegistry.openSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly handle: string;
    readonly owner: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) {
    const notRegistered = new McpProviderSession.ReviewAssignmentRefusedError({
      reason: "the assignment is not registered",
    });
    // Another thread's handle refuses as an unknown one, so a reviewer learns nothing about it.
    const broker = ownedBroker(input);
    if (broker === undefined) return yield* notRegistered;
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
        // Revoked or evicted during the file work: refuse now rather than at attestation.
        if (currentBroker(input.handle) !== broker) {
          yield* removeWorkspace(workspace);
          return undefined;
        }
        const opened: OpenSession = {
          handle: input.handle,
          broker,
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
    if (session === undefined) return yield* notRegistered;

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
      if (currentBroker(session.handle) !== session.broker) {
        return yield* refuse("the assignment is not registered");
      }
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
      const recordSession = session.broker.recordSession;
      if (recordSession !== undefined) {
        yield* Effect.tryPromise(() => recordSession(verified)).pipe(
          Effect.catch(() => refuse("the assignment could not record the session")),
        );
      }
      // The session can close, or the assignment end or be replaced, while its record is written.
      if (sessions.get(input.threadId) !== session) {
        return yield* refuse("the restricted session was closed");
      }
      if (currentBroker(session.handle) !== session.broker) {
        return yield* refuse("the assignment is not registered");
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
    const runId = session?.attestedRunId;
    if (
      session === undefined ||
      session.handle !== caller.handle ||
      currentBroker(caller.handle) !== session.broker ||
      runId === undefined
    ) {
      return yield* new ReviewMaterialUnavailableError();
    }
    const broker = session.broker;
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

  const isRegistered = Effect.fn("ReviewAssignmentRegistry.isRegistered")(
    (input: { readonly owner: ThreadId; readonly handle: string }) =>
      Effect.sync(() => ownedBroker(input) !== undefined),
  );

  return ReviewAssignmentRegistry.of({
    register,
    registerFiles,
    revoke,
    isRegistered,
    openSession,
    closeSession,
    readMaterial,
    evidence,
  });
});

export const layer = Layer.effect(ReviewAssignmentRegistry, make);
