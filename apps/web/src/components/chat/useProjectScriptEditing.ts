import type { EnvironmentId, ProjectScript } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ProjectScriptChange,
  ProjectScriptSaveInput,
} from "@t3tools/client-runtime/state/projectScriptSaves";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import { useStableCallback } from "../../hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSaveProjectScripts } from "../useSaveProjectScripts";
import { t } from "~/i18n";

/** The chat's project actions control edits the active project's list. */
export function useProjectScriptEditing(input: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
}) {
  const { environmentId, project, scripts } = input;
  const saveProjectScripts = useSaveProjectScripts();
  const save = (change: ProjectScriptChange): Promise<AtomCommandResult<void, unknown>> =>
    project
      ? saveProjectScripts([{ environmentId, projectId: project.id }], change)
      : Promise.resolve(AsyncResult.success(undefined));

  const deleteProjectScript = async (scriptId: string) => {
    const deletedName = scripts.find((script) => script.id === scriptId)?.name;
    const result = await save({ kind: "delete", scriptId });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t('Deleted action "{name}"', { name: deletedName ?? t("Unknown") }),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not delete action"),
          description: error instanceof Error ? error.message : t("An unexpected error occurred."),
        }),
      );
    }
    return result;
  };
  return {
    saveProjectScript: useStableCallback((input: ProjectScriptSaveInput) =>
      save({ kind: "save", scriptId: null, input }),
    ),
    updateProjectScript: useStableCallback((scriptId: string, input: ProjectScriptSaveInput) =>
      save({ kind: "save", scriptId, input }),
    ),
    deleteProjectScript: useStableCallback(deleteProjectScript),
  };
}
