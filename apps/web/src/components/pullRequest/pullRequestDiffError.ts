import { msg, t } from "~/i18n";

import type { ChangeRequestTermKind } from "./changeRequestTerm";

/** Diff failures currently include transport wrappers, so recognize the reason inside them. */
export function describePullRequestDiffError(
  error: string,
  providerName: string,
  term: ChangeRequestTermKind,
  resolve: typeof t = t,
) {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/i.test(error)) {
    return {
      title: resolve(msg("{providerName} rate limit reached"), { providerName }),
      description: resolve(
        msg(
          "{providerName} is temporarily limiting requests, so this diff couldn't be loaded. Try again after the limit resets, or view the changes on {providerName}.",
        ),
        { providerName },
      ),
    };
  }

  return {
    title: resolve(msg("Couldn't load the changes")),
    description:
      term === "mr"
        ? resolve(
            msg(
              "The environment couldn't load this merge request's diff. Try again, or view the changes on {providerName}.",
            ),
            { providerName },
          )
        : term === "cr"
          ? resolve(
              msg(
                "The environment couldn't load this change request's diff. Try again, or view the changes on {providerName}.",
              ),
              { providerName },
            )
          : resolve(
              msg(
                "The environment couldn't load this pull request's diff. Try again, or view the changes on {providerName}.",
              ),
              { providerName },
            ),
  };
}
