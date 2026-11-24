import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

export const starsAfterRunRollback = Effect.fn("messageStars.starsAfterRunRollback")(function* (
  projections: ProjectionStoreV2["Service"],
  threadId: ThreadId,
  runIds: ReadonlyArray<RunId>,
) {
  if (runIds.length === 0) return undefined;
  const thread = yield* projections.getThread(threadId);
  const stars = thread.starredMessageIds ?? [];
  if (stars.length === 0) return undefined;
  const removed = new Set(yield* projections.getMessageIdsInRuns(threadId, stars, runIds));
  if (removed.size === 0) return undefined;
  return stars.filter((id) => !removed.has(id));
});
