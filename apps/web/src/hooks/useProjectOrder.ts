import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import {
  applyHeldProjectOrder,
  holdProjectOrder,
  planProjectGroupMove,
  releaseProjectOrder,
  type HeldProjectOrder,
  type OrderedProject,
} from "@t3tools/client-runtime/state/project-order";
import { create } from "zustand";

import { t } from "~/i18n";
import { readProjects, useProjects } from "../state/entities";
import { readEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { reportProjectFailure } from "./useProjectGroupUpdate";
import { getClientSettings, updateClientSettings } from "./useSettings";

const useHeldProjectOrder = create<{ readonly held: HeldProjectOrder }>(() => ({
  held: new Map(),
}));

/** Every project, with the moves this client sent and the server has not shown yet. */
export function useOrderedProjects() {
  const projects = useProjects();
  const held = useHeldProjectOrder((state) => state.held);
  return applyHeldProjectOrder(projects, held);
}

/** Machines that are offline, on an older server, or not ours to change keep their keys. */
function canWriteProjectOrder(environmentId: EnvironmentId): boolean {
  const environment = readEnvironment(environmentId);
  return (
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.projectOrder === true &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
  );
}

/** A project moves while one of its machines can take the move; the rest catch up on the next. */
export const canMoveProjectGroup = (members: ReadonlyArray<OrderedProject>) =>
  members.some((member) => canWriteProjectOrder(member.environmentId));

/**
 * Saves a move on every machine that has the moved projects, shows it at once, and sets Project
 * order to Manual so the order shown is the one kept.
 */
export function useMoveProjectGroup() {
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  return async <TGroup>(input: {
    readonly groups: ReadonlyArray<TGroup>;
    readonly keyOf: (group: TGroup) => string;
    readonly projectsOf: (group: TGroup) => ReadonlyArray<OrderedProject>;
    /** One list of sibling groups, already in the order the move leaves them. */
    readonly orderedKeys: readonly string[];
    readonly movedKey: string;
  }) => {
    const manual = getClientSettings().sidebarProjectSortOrder === "manual";
    const assignments = planProjectGroupMove({ ...input, followsKeys: manual }).filter(
      (assignment) => canWriteProjectOrder(assignment.environmentId),
    );
    if (assignments.length === 0) return;
    useHeldProjectOrder.setState(({ held }) => ({
      held: holdProjectOrder(readProjects(), held, assignments, new Date().toISOString()),
    }));
    if (!manual) void updateClientSettings({ sidebarProjectSortOrder: "manual" });
    const results = await Promise.all(
      assignments.map(async (assignment) => ({
        assignment,
        result: await updateProject({
          environmentId: assignment.environmentId,
          input: { projectId: assignment.projectId, orderKey: assignment.orderKey },
        }),
      })),
    );
    const failed = results.filter(({ result }) => result._tag === "Failure");
    if (failed.length === 0) return;
    useHeldProjectOrder.setState(({ held }) => ({
      held: releaseProjectOrder(
        held,
        failed.map(({ assignment }) => assignment),
      ),
    }));
    reportProjectFailure(t("Failed to move project"), failed[0]!.result);
  };
}
