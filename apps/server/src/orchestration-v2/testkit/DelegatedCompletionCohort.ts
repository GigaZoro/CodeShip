import { EventId, type RunId, type ThreadId } from "@t3tools/contracts/baseSchemas";
import type {
  OrchestrationV2DelegatedCompletionCohort,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts/orchestrationV2";
import type * as DateTime from "effect/DateTime";

/** Seeds a run's cohort the only way the sink accepts one: run.updated never carries it. */
export const delegatedCompletionUpdated = (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly occurredAt: DateTime.Utc;
  readonly delegatedCompletion: OrchestrationV2DelegatedCompletionCohort;
}): OrchestrationV2DomainEvent => ({
  id: EventId.make(input.id),
  type: "run.delegated-completion-updated",
  threadId: input.threadId,
  runId: input.runId,
  occurredAt: input.occurredAt,
  payload: { runId: input.runId, delegatedCompletion: input.delegatedCompletion },
});
