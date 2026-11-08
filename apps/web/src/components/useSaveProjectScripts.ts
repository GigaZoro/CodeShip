import { AuthSettingsWriteScope } from "@t3tools/contracts";
import {
  saveProjectScripts,
  type ProjectScriptChange,
  type ProjectScriptList,
} from "@t3tools/client-runtime/state/projectScriptSaves";
import { useStableCallback } from "../hooks/useStableCallback";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/** Web's way to change actions; see `saveProjectScripts`. */
export function useSaveProjectScripts() {
  const updateProjectScripts = useAtomCommand(serverEnvironment.updateProjectScripts, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  return useStableCallback((lists: readonly ProjectScriptList[], change: ProjectScriptChange) =>
    saveProjectScripts(
      {
        config: (environmentId) =>
          appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
        projects: (environmentId) =>
          appAtomRegistry
            .get(environmentProjects.projectsAtom)
            .filter((project) => project.environmentId === environmentId),
        canWriteSettings: (environmentId) =>
          readEnvironmentScope(environmentId, AuthSettingsWriteScope),
        updateProjectScripts,
        upsertKeybinding,
        removeKeybinding,
      },
      lists,
      change,
    ),
  );
}
