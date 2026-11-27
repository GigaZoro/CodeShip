import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AUTHENTICATION_FAILED_FAILURE_CODE,
  AntigravitySettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  type ServerProvider,
  type ServerProviderAuthStatus,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeMuseSignedOut } from "@t3tools/provider-muse/testing";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  ACCOUNT_FAILOVER_DRIVERS,
  type AccountFailoverDriver,
} from "@t3tools/shared/serverSettings";
import * as EffectAcpErrors from "effect-acp/errors";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { makeAntigravityProvider } from "../../provider/AntigravityProvider.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import { makeClaudeAuthenticationFailure } from "../../provider/claudeSignedOut.ts";
import { checkCodexProviderStatus } from "../../provider/CodexProvider.ts";
import { makeAntigravityAdapterV2 } from "../Adapters/AntigravityAdapterV2.ts";
import { makeClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { makeCodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import {
  makeMuseOrchestratorReplayHarness,
  materializeMuseReplayWorkspace,
} from "../Adapters/MuseAdapterV2.testkit.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as CommandOutputRecorder from "./CommandOutputRecorder.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  assertBaseProjection,
  CLAUDE_MODEL_SELECTION,
  CLAUDE_RESULT_IS_ERROR_PROMPT,
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  MUSE_MODEL_SELECTION,
  projectionFor,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2Scenario,
  type OrchestratorV2ScenarioResult,
} from "./OrchestratorScenario.ts";
import {
  layerWithRegistry,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { runReplayFixture, type ReplayFixtureRun } from "./ProviderReplayFixtures.ts";

const FIXTURE_NAME = "rejected_login";
const DAY_MS = 24 * 60 * 60 * 1000;
const CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({ binaryPath: "/nonexistent/codex" });
const ANTIGRAVITY_SETTINGS = Schema.decodeSync(AntigravitySettings)({ enabled: true });
const ANTIGRAVITY_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.0.0" },
};

type DatabaseLayer = NonNullable<
  ReplayFixtureRun<ProviderReplayTranscript, never>["databaseLayer"]
>;

function assertRejectedLoginOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });
  const projection = projectionFor(result, FIXTURE_NAME);
  const [run] = projection.runs;
  const error = projection.turnItems.find(
    (item) => item.runId === run?.id && item.type === "error" && item.nodeId === run.rootNodeId,
  );
  if (error?.type !== "error") throw new Error("the rejected login left no error on the run");
  assert.equal(error.failure.code, AUTHENTICATION_FAILED_FAILURE_CODE);
}

const replay = <Transcript extends ProviderReplayTranscript, Error, WorkspaceError = never>(input: {
  readonly variant: Omit<ProviderOrchestratorReplayVariant, "assertOutput">;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  readonly databaseLayer: DatabaseLayer;
  readonly materializeWorkspace?: ReplayFixtureRun<
    Transcript,
    Error,
    WorkspaceError
  >["materializeWorkspace"];
}) =>
  runReplayFixture({
    fixtureName: FIXTURE_NAME,
    buildInput: () => ({ steps: [{ type: "message", text: CLAUDE_RESULT_IS_ERROR_PROMPT }] }),
    driver: { ...input.variant, assertOutput: assertRejectedLoginOutput },
    harness: input.harness,
    databaseLayer: input.databaseLayer,
    ...(input.materializeWorkspace === undefined
      ? {}
      : { materializeWorkspace: input.materializeWorkspace }),
  });

const probed = (driver: AccountFailoverDriver, auth: ServerProviderAuthStatus): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: auth },
  checkedAt: "1970-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

interface RejectedLoginCase {
  /** Replays the driver's rejected login with its driver's sign-out wiring. */
  readonly run: (databaseLayer: DatabaseLayer) => Effect.Effect<
    {
      readonly result: OrchestratorV2ScenarioResult;
      /** The account's auth status once the driver has seen the rejection. */
      readonly authStatus: ServerProviderAuthStatus;
    },
    Error
  >;
}

// A failover driver without a case here fails typecheck.
const CASES = {
  codex: {
    run: Effect.fn("RejectedLogin.codex")(function* (databaseLayer: DatabaseLayer) {
      const rechecked = yield* Ref.make(false);
      const result = yield* replay({
        variant: {
          driver: ProviderDriverKind.make("codex"),
          transcriptFile: new URL(
            "./fixtures/rejected_login/codex_transcript.ndjson",
            import.meta.url,
          ),
          modelSelection: CODEX_MODEL_SELECTION,
        },
        harness: makeCodexOrchestratorReplayHarness({
          onAuthenticationFailed: Ref.set(rechecked, true),
        }),
        databaseLayer,
        materializeWorkspace: (transcript, workspace) =>
          Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
      });
      assert.isTrue(yield* Ref.get(rechecked), "Codex must re-check a login it saw rejected");
      // The re-check reads the account, which Codex refuses the same way.
      const status = yield* checkCodexProviderStatus(CODEX_SETTINGS, () =>
        Effect.fail(
          new CodexErrors.CodexAppServerRequestError({
            code: -32603,
            errorMessage: "workspace routing discovery unauthorized (401)",
            method: "account/read",
          }),
        ),
      ).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
      return { result, authStatus: status.auth.status };
    }),
  },
  claudeAgent: {
    run: Effect.fn("RejectedLogin.claudeAgent")(function* (databaseLayer: DatabaseLayer) {
      const failure = yield* makeClaudeAuthenticationFailure(
        Effect.succeed("2026-12-01T00:00:00.000Z"),
      );
      const result = yield* replay({
        variant: {
          driver: ProviderDriverKind.make("claudeAgent"),
          transcriptFile: new URL(
            "./fixtures/claude_result_is_error/claude_transcript.ndjson",
            import.meta.url,
          ),
          transcriptEntriesThroughLabel: "result:1_is_error",
          modelSelection: CLAUDE_MODEL_SELECTION,
        },
        harness: makeClaudeOrchestratorReplayHarness({ onAuthenticationFailed: failure.record }),
        databaseLayer,
      });
      const snapshot = yield* failure.apply(probed("claudeAgent", "authenticated"));
      return { result, authStatus: snapshot.auth.status };
    }),
  },
  muse: {
    run: Effect.fn("RejectedLogin.muse")(function* (databaseLayer: DatabaseLayer) {
      const signedOut = yield* makeMuseSignedOut("Muse rejected the login.");
      const result = yield* replay({
        variant: {
          driver: ProviderDriverKind.make("muse"),
          transcriptFile: new URL(
            "./fixtures/rejected_login/muse_transcript.ndjson",
            import.meta.url,
          ),
          modelSelection: MUSE_MODEL_SELECTION,
        },
        harness: makeMuseOrchestratorReplayHarness({ login: signedOut.launch }),
        databaseLayer,
        materializeWorkspace: materializeMuseReplayWorkspace,
      });
      const snapshot = yield* signedOut.apply(probed("muse", "unknown"));
      return { result, authStatus: snapshot.auth.status };
    }),
  },
  antigravity: {
    run: Effect.fn("RejectedLogin.antigravity")(function* (databaseLayer: DatabaseLayer) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("antigravity");
          const driver = ProviderDriverKind.make("antigravity");
          const provider = yield* makeAntigravityProvider(ANTIGRAVITY_SETTINGS, {
            stampIdentity: (snapshot) => Effect.succeed({ ...snapshot, instanceId, driver }),
            probe: Effect.succeed(ANTIGRAVITY_INITIALIZE),
            supportsTextGeneration: Effect.succeed(true),
          }).pipe(Effect.provide(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))));
          yield* provider.snapshot.refresh;

          const workspace = yield* checkpointWorkspace(FIXTURE_NAME);
          const materialized = yield* materializeFixtureInput({
            scenario: FIXTURE_NAME,
            fixtureInput: { steps: [{ type: "message", text: CLAUDE_RESULT_IS_ERROR_PROMPT }] },
            driver,
            modelSelection: { instanceId, model: "gemini-4-neon" },
          }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
          const scenario = {
            name: `${FIXTURE_NAME}/${driver}`,
            commands: materialized.commands,
            steps: materialized.steps,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: { cwd: workspace },
          };
          const registryLayer = ProviderAdapterRegistry.layerFromAdaptersEffect(
            Effect.gen(function* () {
              return [
                yield* makeAntigravityAdapterV2({
                  instanceId,
                  selfInvocation: yield* resolveSelfInvocation(),
                  makeRuntime: () =>
                    Effect.fail(EffectAcpErrors.AcpRequestError.authRequired()).pipe(
                      Effect.tapError((cause) =>
                        isAntigravitySignInRequiredError(cause)
                          ? provider.onAuthRequired
                          : Effect.void,
                      ),
                    ),
                  withProcess: (_stop, task) => task,
                  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                  defaultModel: Effect.succeed(undefined),
                }),
              ];
            }),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
                NodeServices.layer,
                IdAllocator.layer,
              ),
            ),
          );
          const layer = layerWithRegistry(scenario, registryLayer, { databaseLayer });
          const result = yield* Effect.gen(function* () {
            const scenarioResult = yield* runOrchestratorV2Scenario(scenario);
            const recorder = yield* CommandOutputRecorder.CommandOutputRecorder;
            return { ...scenarioResult, commandOutput: yield* recorder.snapshot };
          }).pipe(Effect.provide(layer), provideDeterministicTestRuntime);

          const projection = projectionFor(result, FIXTURE_NAME);
          const [run] = projection.runs;
          assert.equal(run?.status, "failed");
          const error = projection.turnItems.find(
            (item) =>
              item.runId === run?.id && item.type === "error" && item.nodeId === run.rootNodeId,
          );
          if (error?.type !== "error") {
            throw new Error("the rejected login left no error on the run");
          }
          assert.equal(error.failure.code, AUTHENTICATION_FAILED_FAILURE_CODE);
          const snapshot = yield* provider.snapshot.getSnapshot;
          return { result, authStatus: snapshot.auth.status };
        }),
      ).pipe(Effect.orDie);
    }),
  },
} satisfies Record<AccountFailoverDriver, RejectedLoginCase>;

describe("rejected login failover", () => {
  it.effect.each(ACCOUNT_FAILOVER_DRIVERS)(
    "%s signs out an account whose login was rejected and moves its run to another account",
    (driver) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rejected-login-" });
        const databaseLayer = SqlitePersistence.layerFromPath(
          path.join(directory, "state.sqlite"),
        ).pipe(Layer.provide(NodeServices.layer));

        const { result, authStatus } = yield* CASES[driver].run(databaseLayer);

        assert.equal(authStatus, "unauthenticated");
        const [run] = projectionFor(result, FIXTURE_NAME).runs;
        assert.isDefined(run, "the rejected run was not projected");
        const now = run.completedAt;
        assert.isNotNull(now, "the rejected run never completed");
        const candidates = yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.flatMap((store) => store.getSignedOutCandidates({ now, maxAgeMs: DAY_MS })),
          Effect.provide(ProjectionStore.layer.pipe(Layer.provide(databaseLayer))),
        );
        assert.deepEqual(
          candidates.map((candidate) => candidate.latestRunId),
          [run.id],
        );
        assert.isFalse(candidates[0]?.workDone, "the rejected run counted as work");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
