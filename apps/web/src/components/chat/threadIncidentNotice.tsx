import type {
  ThreadIncidentCause,
  ThreadIncidentKind,
} from "@t3tools/client-runtime/state/thread-incidents";
import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";
import type { ThreadIncidentPresentation } from "../incidents/threadIncidentPresentation";
import type { ThreadNotice, ThreadNoticeProducer } from "./threadNoticeSlot.logic";

/** The notice that reports each cause in a thread; the incident speaks through it. */
const INCIDENT_PRODUCERS = {
  "machine-offline": "environmentUnavailable",
  "usage-limit": "usageLimitRecovery",
  "provider-outage": "providerStatus",
} as const satisfies Record<ThreadIncidentKind, ThreadNoticeProducer>;

/**
 * Names the shared cause and how many threads it holds on the notice that already reports it,
 * so the thread shows one notice for the incident. A usage-limit notice keeps its own title,
 * which for ChatGPT accounts is wording OpenAI specifies.
 */
export function withThreadIncidentNotice(
  notices: ReadonlyArray<ThreadNotice>,
  incident: {
    readonly cause: ThreadIncidentCause;
    readonly view: ThreadIncidentPresentation;
  } | null,
): ReadonlyArray<ThreadNotice> {
  if (incident === null) return notices;
  const { cause, view } = incident;
  const producer = INCIDENT_PRODUCERS[cause.kind];
  // The composer can show another provider's status than the one that failed these threads.
  const id =
    cause.kind === "provider-outage"
      ? `provider-status:${cause.environmentId}:${cause.providerInstanceId}`
      : null;
  const index = notices.findIndex(
    (notice) => notice.producer === producer && (id === null || notice.id === id),
  );
  if (index === -1) return notices;
  const notice = notices[index]!;
  const action = (
    <Button size="xs" variant="ghost" render={<Link to={view.to} />}>
      {view.actionLabel}
    </Button>
  );
  const actions = (
    <>
      {notice.actions}
      {action}
    </>
  );
  // The count changes as threads join; announcing the notice's own title keeps that quiet.
  const announcement =
    notice.announcement ?? (typeof notice.title === "string" ? notice.title : undefined);
  const decorated: ThreadNotice =
    cause.kind === "usage-limit"
      ? {
          ...notice,
          description:
            notice.description == null ? (
              view.summary
            ) : (
              <>
                {view.summary} · {notice.description}
              </>
            ),
          actions,
        }
      : {
          ...notice,
          title: view.summary,
          ...(announcement === undefined ? {} : { announcement }),
          actions,
        };
  return notices.with(index, decorated);
}
