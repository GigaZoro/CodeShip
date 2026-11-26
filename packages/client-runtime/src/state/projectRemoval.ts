import { t, tn } from "@t3tools/shared/i18n";
import { isListedThreadLineage } from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

export function planProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage">,
>(
  options: {
    readonly members: ReadonlyArray<
      Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
        readonly environmentLabel?: string | null;
      }
    >;
    readonly groupMemberCount: number;
    readonly hasOtherMembers: boolean;
    readonly displayName: string;
    readonly threads: ReadonlyArray<Thread>;
    /** The members' threads this client does not hold: older settled threads its shell left out. */
    readonly unloadedThreadCount?: number;
  },
  resolve: typeof t = t,
) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  // Side chats and subagents go with their parent but never show in thread lists.
  const threadCount =
    projectThreads.filter((thread) => isListedThreadLineage(thread.lineage)).length +
    (options.unloadedThreadCount ?? 0);
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const confirmationMessage = [
    threadCount > 0
      ? targetKind === "checkout"
        ? tn(
            threadCount,
            'Remove checkout "{label}" and delete its {count} thread?',
            'Remove checkout "{label}" and delete its {count} threads?',
            { label: targetLabel },
          )
        : tn(
            threadCount,
            'Remove project "{label}" and delete its {count} thread?',
            'Remove project "{label}" and delete its {count} threads?',
            { label: targetLabel },
          )
      : targetKind === "checkout"
        ? resolve('Remove checkout "{label}"?', { label: targetLabel })
        : resolve('Remove project "{label}"?', { label: targetLabel }),
    ...(singleMember
      ? [
          resolve("Path: {path}", { path: singleMember.workspaceRoot }),
          ...(singleMember.environmentLabel
            ? [
                resolve("Environment: {environment}", {
                  environment: singleMember.environmentLabel,
                }),
              ]
            : []),
        ]
      : [
          tn(
            members.length,
            "This removes {count} grouped project entry.",
            "This removes {count} grouped project entries.",
          ),
        ]),
    ...(threadCount > 0
      ? [
          resolve(
            "Those threads and any archived threads are deleted from T3.CodeShip. Provider sessions are kept.",
          ),
        ]
      : [
          resolve("Any archived threads are deleted from T3.CodeShip. Provider sessions are kept."),
        ]),
    isWholeGroup && !hasOtherMembers
      ? resolve("This removes only the project entries, not the files on disk.")
      : resolve("Other entries in this grouped project are unaffected."),
    resolve("This action cannot be undone."),
  ].join("\n");

  return { projectThreads, isWholeGroup, targetKind, confirmationMessage };
}
