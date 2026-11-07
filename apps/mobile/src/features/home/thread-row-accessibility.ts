import { t } from "../../lib/i18n";

/** What a thread row shows, in the order a screen reader reads it. */
export interface ThreadRowSpeech {
  readonly title: string;
  /** The status the row shows, with its duration when it shows one. */
  readonly status: { readonly label: string; readonly duration: string | null } | null;
  /** The unreachable machine's state; the status is then only what was last seen. */
  readonly lastKnownMachine: string | null;
  readonly woke: boolean;
  /** The time or wake time the row shows where it has no status. */
  readonly time: string | null;
  readonly error: string | null;
  readonly pinned: boolean;
  readonly scheduledTask: boolean;
  readonly queuedMessages: boolean;
  readonly regeneratingTitle: boolean;
  readonly searchExcerpt: string | null;
  readonly project: string | null;
  readonly environment: string | null;
  readonly pullRequest: string | null;
}

/** The row's label replaces its text for screen readers, so it says everything the row shows. */
export function threadRowAccessibilityLabel(row: ThreadRowSpeech): string {
  const status = row.woke
    ? t("Woke")
    : row.status && row.lastKnownMachine !== null
      ? t("{machine}, last known status: {status}", {
          machine: row.lastKnownMachine,
          status: row.status.label,
        })
      : row.status
        ? row.status.duration
          ? `${row.status.label} ${row.status.duration}`
          : row.status.label
        : row.time || null;
  return [
    row.title,
    status,
    row.error,
    row.pinned ? t("pinned") : null,
    row.scheduledTask ? t("scheduled task") : null,
    row.queuedMessages ? t("messages queued to send") : null,
    row.regeneratingTitle ? t("regenerating title") : null,
    row.searchExcerpt,
    row.project,
    row.environment,
    row.pullRequest,
  ]
    .filter(Boolean)
    .join(", ");
}

export type ThreadRowPrimaryAction = "archive" | "unsnooze" | "unsettle" | "settle";

/**
 * Screen readers cannot swipe a row open or find its long-press menu, so the row offers its
 * swipe actions as accessibility actions. Names are the row menu's event ids.
 */
export function threadRowAccessibilityActions(input: {
  readonly canOperate: boolean;
  readonly primary: { readonly kind: ThreadRowPrimaryAction; readonly label: string };
  /** Null when the row cannot be snoozed now. */
  readonly snoozePresets: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly whenLabel: string;
  }> | null;
  readonly pullRequest: string | null;
  readonly dismissWoke: boolean;
}): ReadonlyArray<{ readonly name: string; readonly label: string }> {
  return [
    ...(input.canOperate
      ? [
          { name: input.primary.kind, label: input.primary.label },
          ...(input.snoozePresets === null
            ? []
            : [
                ...input.snoozePresets.map((preset) => ({
                  name: `snooze:${preset.id}`,
                  label: t("Snooze: {label}, {when}", {
                    label: preset.label,
                    when: preset.whenLabel,
                  }),
                })),
                { name: "snooze:custom", label: t("Custom snooze") },
              ]),
          { name: "delete", label: t("Delete") },
        ]
      : []),
    ...(input.pullRequest ? [{ name: "openPullRequests", label: input.pullRequest }] : []),
    ...(input.dismissWoke ? [{ name: "dismissWoke", label: t("Dismiss Woke notification") }] : []),
  ];
}
