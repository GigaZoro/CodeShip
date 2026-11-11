import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useContext } from "react";
import {
  createManualStepsEnvironmentAtoms,
  manualStepAttemptChat,
  manualStepReviewState,
  manualStepStartChatInput,
  manualStepsEnvironmentIdsKey,
  type ManualStepReviewState,
  type ManualStepsState,
} from "@t3tools/client-runtime/state/manualSteps";
import {
  type EnvironmentId,
  type ManualStep,
  type ManualStepDecision,
  type ManualStepReview,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";
import { useServerConfigs, useThreadShell } from "./entities";
import { useAtomCommand } from "./use-atom-command";

const manualStepsEnvironment = createManualStepsEnvironmentAtoms(connectionAtomRuntime);

const NO_MANUAL_STEPS_ATOM = Atom.make<ManualStepsState | null>(null).pipe(
  Atom.withLabel("mobile:manual-steps:none"),
);

/** Null when no connected machine serves the list; one machine with a token fills it. */
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
  Atom.withLabel("mobile:manual-steps:review:none"),
);

/**
 * The AI review of one step, asked for by whoever shows the step, so every listed step is
 * reviewed before it is opened. Null when no connected machine serves reviews.
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
  Atom.make(false).pipe(Atom.withLabel(`mobile:manual-steps:reviewing-again:${threadId}`)),
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

/**
 * Starts the chat that carries out the user's decision on a step. `pending` is the decision on
 * its way. `started` is the chat this session started for the step: the newest whose start
 * succeeded, or one the thread list shows with its message although its answer never arrived.
 */
export function useStartManualStepChat(step: ManualStep) {
  const run = useAtomCommand(manualStepsEnvironment.startChat, "manual step start chat");
  const registry = useContext(RegistryContext);
  const { attempt, chat } = useAtomValue(manualStepsEnvironment.start(step.threadId));
  const unanswered = attempt === null || attempt.inFlight ? null : manualStepAttemptChat(attempt);
  const attemptStarted = useThreadShell(unanswered)?.latestUserMessageAt != null;
  return {
    pending: attempt?.inFlight ? attempt.decision : null,
    started: attemptStarted ? unanswered : chat,
    /** Null while another start for the step is on its way: nothing is sent. */
    start: (environmentId: EnvironmentId, decision: ManualStepDecision) => {
      const commandId = manualStepsEnvironment.beginStart(
        registry,
        { stepThreadId: step.threadId, environmentId, decision },
        { attemptStarted, newId: uuidv4 },
      );
      return commandId === null
        ? null
        : run({
            environmentId,
            input: manualStepStartChatInput(step, decision, commandId, "mobile"),
          }).then((result) => {
            if (result._tag === "Failure") {
              manualStepsEnvironment.failStart(registry, step.threadId, commandId);
            }
            return result;
          });
    },
  };
}
