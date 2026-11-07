import type {
  AgentConversationSyncResult,
  EnvironmentId,
  ScopedThreadRef,
  ServerSettings,
} from "@t3tools/contracts";
import { t, tn } from "@t3tools/shared/i18n";
import { agentConversationImportPolicy } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";

import { scopeThreadRef } from "./environment/scoped.ts";
import type { AtomCommandResult } from "./state/runtime.ts";

export type ConversationImportReport = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
} & ({ readonly result: AgentConversationSyncResult } | { readonly error: string });

export interface ConversationImportNotice {
  readonly type: "success" | "info" | "error";
  readonly title: string;
  readonly description?: string;
  /** The most recently active conversation the import brought in. */
  readonly thread: ScopedThreadRef | null;
}

/** A write that left the same projects importing changes nothing to report. */
export function importPolicyChanged(write: {
  readonly previous: ServerSettings;
  readonly settings: ServerSettings;
}): boolean {
  return (
    agentConversationImportPolicy(write.previous) !== agentConversationImportPolicy(write.settings)
  );
}

export function conversationImportReport(
  environment: { readonly environmentId: EnvironmentId; readonly label: string },
  result: AtomCommandResult<AgentConversationSyncResult, unknown>,
): ConversationImportReport {
  const { environmentId, label } = environment;
  if (result._tag === "Success") return { environmentId, label, result: result.value };
  const error = Cause.squash(result.cause);
  return {
    environmentId,
    label,
    error:
      error instanceof Error ? error.message : t("The connection closed. Reconnect and retry."),
  };
}

export function conversationImportNotice(
  reports: ReadonlyArray<ConversationImportReport>,
): ConversationImportNotice {
  let importedCount = 0;
  let latest: { readonly ref: ScopedThreadRef; readonly updatedAt: string } | null = null;
  const problems: string[] = [];
  for (const report of reports) {
    if ("error" in report) {
      problems.push(
        t("Could not import on {label}: {message}", {
          label: report.label,
          message: report.error,
        }),
      );
      continue;
    }
    const { result } = report;
    importedCount += result.importedCount;
    if (
      result.latestThread !== null &&
      (latest === null || result.latestThread.updatedAt > latest.updatedAt)
    ) {
      latest = {
        ref: scopeThreadRef(report.environmentId, result.latestThread.threadId),
        updatedAt: result.latestThread.updatedAt,
      };
    }
    if (!result.complete) {
      problems.push(t("Some projects on {label} could not be imported.", { label: report.label }));
    }
  }
  const description = problems.length > 0 ? { description: problems.join("\n") } : {};
  if (importedCount > 0) {
    return {
      type: "success",
      title: tn(
        importedCount,
        "Imported {count} conversation · find it under Settled",
        "Imported {count} conversations · find them under Settled",
      ),
      ...description,
      thread: latest?.ref ?? null,
    };
  }
  if (problems.length === 0) {
    return { type: "info", title: t("No new conversations to import"), thread: null };
  }
  return {
    type: "error",
    title: t("Could not import conversations"),
    ...description,
    thread: null,
  };
}
