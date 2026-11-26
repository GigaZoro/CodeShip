import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  useThreadGitMenuDefinition,
  useThreadTerminalMenu,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import type { ThreadPinAction } from "./useThreadPinAction";
import { t } from "../../lib/i18n";
import { useThreadPreferenceMenu } from "./useThreadPreferenceMenu";

export function ThreadHeader(props: {
  readonly thread?: Parameters<typeof useThreadPreferenceMenu>[0];
  readonly onOpenStarred?: () => void;
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly pin?: ThreadPinAction | null;
}) {
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = useThreadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? t("Close files") : t("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  if (props.pin) {
    actions.push({
      accessibilityLabel: props.pin.pinned ? t("Unpin thread") : t("Pin thread"),
      icon: props.pin.pinned ? "pin.slash" : "pin",
      onPress: props.pin.onToggle,
    });
  }
  if (props.onOpenStarred) {
    actions.push({
      accessibilityLabel: t("Starred messages"),
      icon: "star.fill",
      onPress: props.onOpenStarred,
    });
  }
  const preferences = useThreadPreferenceMenu(props.thread);
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  if (preferences.items.length > 0) {
    menus.push({
      title: t("Thread preferences"),
      icon: "ellipsis.circle",
      items: preferences.items.map((item) => ({
        id: item.id,
        title: item.label,
        items: item.children.map((child) => ({
          id: child.id,
          title: child.label,
          selected: child.checked,
          onPress: () => {
            preferences.select(child.id);
          },
        })),
      })),
    });
  }

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: t("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}
