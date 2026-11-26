import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AccountRouting, creditRefusalMessage } from "./AccountRouting.ts";
import * as Orchestrator from "./Orchestrator.ts";

/**
 * Stops a turn once it spends prepaid credits its allowance no longer covers: a reading shows the
 * count at the cap, or the plan used up with spending off or for a thread the allowance leaves out,
 * or the user takes the allowance back. Turn starts refuse the same work (ProviderTurnStartService).
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const accountRouting = yield* AccountRouting;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const settingsChanges = yield* (yield* ServerSettings.ServerSettingsService).subscribeChanges;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const stopOverruns = Effect.flatMap(accountRouting.creditOverruns, (overruns) =>
      Effect.forEach(
        overruns,
        ({ run, refusal }) =>
          orchestrator
            .dispatch({
              type: "run.interrupt",
              // One stop per turn, however many readings show it still running.
              commandId: CommandId.make(`prepaid-credits-stop:${run.id}`),
              threadId: run.threadId,
              runId: run.id,
              reason: creditRefusalMessage(refusal),
            })
            .pipe(
              Effect.flatMap((result) =>
                result.replayed
                  ? Effect.void
                  : Effect.logInfo("orchestration-v2.prepaid-credits.turn-stopped", {
                      runId: run.id,
                      threadId: run.threadId,
                      instanceId: run.providerInstanceId,
                      credits: refusal.credits,
                    }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.prepaid-credits.stop-failed", {
                  runId: run.id,
                  cause,
                }),
              ),
            ),
        { discard: true },
      ),
    );
    yield* forkParked(
      Stream.runForEach(
        Stream.merge(providerRegistry.streamChanges, settingsChanges),
        () => stopOverruns,
      ),
    );
  }),
);
