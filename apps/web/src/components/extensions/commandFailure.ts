import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";

/** The failure's message, or null when the command succeeded or the user interrupted it. */
export function failureMessage(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function reportFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
) {
  const description = failureMessage(result, fallback);
  if (description !== null) toastManager.add({ type: "error", title, description });
}
