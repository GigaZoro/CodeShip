import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useContext } from "react";
import {
  createManualStepsEnvironmentAtoms,
  manualStepReviewState,
  manualStepsEnvironmentIdsKey,
  type ManualStepReviewState,
  type ManualStepsState,
} from "@t3tools/client-runtime/state/manualSteps";
import type { EnvironmentId, ManualStep, ManualStepReview } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useAtomCommand } from "./use-atom-command";

const manualStepsEnvironment = createManualStepsEnvironmentAtoms(connectionAtomRuntime);

const NO_MANUAL_STEPS_ATOM = Atom.make<ManualStepsState | null>(null).pipe(
  Atom.withLabel("manual-steps:none"),
);

/**
 * Every connected machine that serves the list reads the same ThreadPage folders, so one with a
 * token is enough. Null when no connected machine serves it.
 */
export function useManualSteps(): {
  readonly state: ManualStepsState | null;
  readonly refresh: () => void;
} {
  const environmentsKey = manualStepsEnvironmentIdsKey(useServerConfigs());
  const atom =
    environmentsKey === null ? NO_MANUAL_STEPS_ATOM : manualStepsEnvironment.view(environmentsKey);
  return { state: useAtomValue(atom), refresh: useAtomRefresh(atom) };
}

const NO_REVIEW_ATOM = Atom.make(AsyncResult.initial<ManualStepReview, never>()).pipe(
  Atom.withLabel("manual-steps:review:none"),
);

/**
 * The AI review of one step, asked for by whoever shows the step, so every listed step is
 * reviewed without a click. Null when no connected machine serves reviews.
 */
export function useManualStepReview(
  step: Pick<ManualStep, "threadId" | "updatedAt">,
  reviewEnvironmentId: EnvironmentId | null,
): { readonly state: ManualStepReviewState | null; readonly retry: () => void } {
  const atom =
    reviewEnvironmentId === null
      ? NO_REVIEW_ATOM
      : manualStepsEnvironment.review({
          environmentId: reviewEnvironmentId,
          input: { threadId: step.threadId, updatedAt: step.updatedAt },
        });
  const result = useAtomValue(atom);
  return {
    state: reviewEnvironmentId === null ? null : manualStepReviewState(result),
    retry: useAtomRefresh(atom),
  };
}

const reviewingAtom = Atom.family((threadId: string) =>
  Atom.make(false).pipe(Atom.withLabel(`manual-steps:reviewing-again:${threadId}`)),
);

/**
 * Asks the reviewing machine for a new review of the step; the review atom shows it on arrival.
 * `running` is per step, so one step's request does not disable another's button.
 */
export function useReviewAgain(
  step: Pick<ManualStep, "threadId" | "updatedAt">,
  reviewEnvironmentId: EnvironmentId | null,
) {
  const run = useAtomCommand(manualStepsEnvironment.reviewAgain, "manual step review again");
  const allowed = useAtomValue(
    manualStepsEnvironment.reviewAgain.permissionAtom(reviewEnvironmentId),
  );
  const registry = useContext(RegistryContext);
  const running = useAtomValue(reviewingAtom(step.threadId));
  return {
    allowed: reviewEnvironmentId !== null && allowed,
    running,
    reviewAgain: () => {
      if (reviewEnvironmentId === null) return Promise.resolve();
      registry.set(reviewingAtom(step.threadId), true);
      return run({
        environmentId: reviewEnvironmentId,
        input: { threadId: step.threadId, updatedAt: step.updatedAt },
      }).then(
        () => registry.set(reviewingAtom(step.threadId), false),
        (error: unknown) => {
          registry.set(reviewingAtom(step.threadId), false);
          throw error;
        },
      );
    },
  };
}
