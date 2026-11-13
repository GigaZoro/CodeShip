import {
  CommandId,
  type OrchestrationV2DomainEvent,
  ProviderRequestKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class UnattendedApprovalReactor extends Context.Service<
  UnattendedApprovalReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/UnattendedApprovalReactor") {}

const isProviderApprovalKind = Schema.is(ProviderRequestKind);

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // Runs for every domain event; the orchestrator decides whether the run is unattended.
  const handle: UnattendedApprovalReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (
        event.type !== "runtime-request.updated" ||
        event.payload.status !== "pending" ||
        event.payload.responseCapability.type !== "live" ||
        !isProviderApprovalKind(event.payload.kind)
      ) {
        return;
      }
      // Only full access asks without the person having chosen to approve each step.
      const thread = yield* projections.getThread(event.threadId);
      if (thread.runtimeMode !== "full-access") return;
      yield* engine.dispatch({
        type: "runtime-request.decline-unattended",
        commandId: CommandId.make(
          `server:unattended-approval-decline:${event.threadId}:${event.payload.id}`,
        ),
        threadId: event.threadId,
        requestId: event.payload.id,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("declining an unattended approval failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: UnattendedApprovalReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("unattended approval event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies UnattendedApprovalReactor["Service"];
});

export const layer = Layer.effect(UnattendedApprovalReactor, make);
