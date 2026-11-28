import { assert, it } from "@effect/vitest";
import { GuestShareId, ProjectId, ThreadId } from "@t3tools/contracts/baseSchemas";
import type { GuestShareAccess } from "@t3tools/contracts/guestShare";
import type { ManagedPolicySummary } from "@t3tools/contracts/managedPolicy";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts/orchestrationV2";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { RuntimeMode } from "@t3tools/contracts/providerPolicy";
import type { ServerProvider } from "@t3tools/contracts/server";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: OrchestrationV2AppThread["interactionMode"];
  readonly guestAccess?: GuestShareAccess | undefined;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...(input.guestAccess === undefined
      ? {}
      : {
          guestShare: {
            id: GuestShareId.make("share:runtime-policy"),
            host: "host.example",
            createdAt: DateTime.formatIso(input.now),
            expiresAt: DateTime.formatIso(input.now),
            guestName: null,
            messages: [],
            access: input.guestAccess,
          },
        }),
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const cursorInstanceId = ProviderInstanceId.make("cursor");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
    orchestrationAdapter: {
      getCapabilities: () =>
        Effect.succeed({
          runtimePolicy: {
            enforcement: "native",
            readOnlySandbox: true,
            ...(instanceId === cursorInstanceId ? {} : { readOnlyGuestAnalysis: true }),
          },
        } as OrchestrationV2ProviderCapabilities),
    } as Pick<ProviderInstance["orchestrationAdapter"], "getCapabilities">,
  }) as ProviderInstance;

const layerWithPolicy = (policy?: ManagedPolicySummary) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, policy)),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            pinnedAt: null,
            archivedAt: null,
            orderKey: null,
            orderedAt: null,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
  );

const layerTest = layerWithPolicy();

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect(
    "runs read-only without asking while a read-only guest link is open, and for runs it started",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const resolve = (
          guestAccess: GuestShareAccess | undefined,
          options: {
            readonly instanceId?: ProviderInstanceId;
            readonly startedReadOnly?: boolean;
          } = {},
        ) =>
          policy.resolve({
            thread: makeThread({
              now,
              worktreePath: "/work",
              guestAccess,
              interactionMode: "plan",
            }),
            modelSelection: {
              instanceId: options.instanceId ?? providerInstanceId,
              model: "test-model",
            },
            ...(options.startedReadOnly === true ? { run: { readOnlyGuestShare: true } } : {}),
          });
        const readOnlyFields = (resolved: { readonly [key: string]: unknown }) => ({
          runtimeMode: resolved.runtimeMode,
          interactionMode: resolved.interactionMode,
          approvalPolicy: resolved.approvalPolicy,
          sandboxPolicy: resolved.sandboxPolicy,
          maxRuntimeMode: resolved.maxRuntimeMode,
          readOnlyGuestShare: resolved.readOnlyGuestShare,
        });
        const readOnlyPolicy = {
          runtimeMode: "approval-required",
          interactionMode: "default",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          maxRuntimeMode: "approval-required",
          readOnlyGuestShare: true,
        };

        assert.deepStrictEqual(readOnlyFields(yield* resolve("read-only")), readOnlyPolicy);
        assert.deepStrictEqual(
          readOnlyFields(yield* resolve(undefined, { startedReadOnly: true })),
          readOnlyPolicy,
        );
        const approve = yield* resolve("approve");
        assert.equal(approve.runtimeMode, "full-access");
        assert.equal(approve.interactionMode, "plan");
        assert.isUndefined(approve.readOnlyGuestShare);
        const refused = yield* resolve("read-only", { instanceId: cursorInstanceId }).pipe(
          Effect.flip,
        );
        assert.equal(refused._tag, "RuntimePolicyReadOnlyUnsupportedError");
      }),
  );
});

it.layer(
  layerWithPolicy({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
)("RuntimePolicyV2 under a runtime mode ceiling", (it) => {
  it.effect("refuses to start a turn above the ceiling, such as one resumed after a restart", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode }),
          modelSelection,
        });

      const refused = yield* resolve("full-access").pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      const allowed = yield* resolve("auto-accept-edits");
      assert.equal(allowed.runtimeMode, "auto-accept-edits");
      assert.equal(allowed.maxRuntimeMode, "auto-accept-edits");
    }),
  );
});
