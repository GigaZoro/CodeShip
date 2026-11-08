import { uuidv4 } from "../../lib/uuid";
import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { AuthFilesystemReadScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { changeRequestTerminologyFor } from "@t3tools/client-runtime/state/vcs";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "../../state/vcs";
import {
  pullSuccess,
  showGitActionResult,
  stackedActionSuccess,
  useVcsActionState,
} from "../../state/use-vcs-action-state";
import { ThreadHeader } from "./ThreadHeader";
import { t } from "../../lib/i18n";

export function DraftThreadHeader(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
  readonly cwd: string | null;
}) {
  const navigation = useNavigation();
  const { themeVariables } = useAppearancePreferences();
  const environmentId = props.thread.environmentId;
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWriteGit = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const status = useEnvironmentQuery(
    props.cwd ? vcsEnvironment.status({ environmentId, input: { cwd: props.cwd } }) : null,
  );
  const target = { environmentId, cwd: props.cwd };
  const progress = useVcsActionState(target);
  const runAction = useAtomCommand(vcsActionManager.runStackedAction(target), {
    reportFailure: false,
  });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const openFiles = () => {
    if (!props.cwd || !canReadFiles) return;
    navigation.navigate("NewTaskFiles", {
      environmentId,
      cwd: props.cwd,
      projectName: props.project.title,
    });
  };
  const requiresThread = () =>
    Dialog.alert(t("Available after the first message"), t("This action needs a saved thread."));
  const showFailure = (cwd: string, cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    showGitActionResult(
      { environmentId, cwd },
      {
        type: "error",
        title: t("Git action failed"),
        description: error instanceof Error ? error.message : t("Git action failed."),
      },
    );
  };
  return (
    <ThreadHeader
      draft
      title={t("New thread")}
      subtitle=""
      headerColor={themeVariables["--color-header"]}
      usesNativeHeaderGlass={NATIVE_LIQUID_GLASS_SUPPORTED}
      hasThreadCwd={props.cwd !== null}
      hasWorkspaceRoot={Boolean(props.project.workspaceRoot)}
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={openFiles}
      onOpenFilesInspector={openFiles}
      onOpenGitInspector={requiresThread}
      gitControls={{
        environmentId,
        threadId: props.thread.id,
        hasThread: false,
        currentBranch: props.thread.branch,
        gitStatus: status.data,
        gitOperationLabel: progress.currentLabel,
        canOpenTerminal: false,
        canOperateTerminal: false,
        canOpenFiles: canReadFiles && props.cwd !== null,
        projectScripts: [],
        terminalSessions: [],
        onOpenFilesInspector: openFiles,
        onOpenGitInspector: requiresThread,
        onOpenTerminal: requiresThread,
        onOpenNewTerminal: requiresThread,
        onRunProjectScript: async () => {
          requiresThread();
        },
        onPull: async () => {
          const cwd = props.cwd;
          if (!canWriteGit || !cwd) return;
          const result = await vcsActionManager.track(
            appAtomRegistry,
            { environmentId, cwd },
            { operation: "pull", label: t("Pulling latest changes") },
            () => pull({ environmentId, input: { cwd } }),
          );
          if (AsyncResult.isFailure(result)) {
            showFailure(cwd, result.cause);
            return;
          }
          showGitActionResult({ environmentId, cwd }, pullSuccess(result.value));
        },
        onRunAction: async (input) => {
          const cwd = props.cwd;
          if (!canWriteGit || !cwd) return null;
          const changeRequestTerminology = changeRequestTerminologyFor(status.data ?? null);
          const result = await runAction({
            ...input,
            projectId: props.project.id,
            actionId: uuidv4(),
            changeRequestTerminology,
          });
          if (AsyncResult.isFailure(result)) {
            showFailure(cwd, result.cause);
            return null;
          }
          showGitActionResult(
            { environmentId, cwd },
            stackedActionSuccess(result.value, changeRequestTerminology),
          );
          return result.value;
        },
      }}
    />
  );
}
