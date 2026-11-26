import { msg, t, type Message } from "../../lib/i18n";
import {
  appendTrackedFolders,
  suggestedTrackedFolders,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectTrackedFolder,
  type WorkspaceFolderState,
} from "@t3tools/contracts";

import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const FOLDER_STATE_LABELS: Record<WorkspaceFolderState, Message> = {
  git: msg("Git repository"),
  plain: msg("Folder"),
  missing: msg("Missing"),
};

/** Tracked folders are paths on one environment, so each checkout gets its own section. */
export function ProjectRepositoriesSection(props: {
  readonly member: EnvironmentProject;
  readonly title: string;
}) {
  const { member } = props;

  const tracked = member.trackedFolders ?? [];
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const canReadFiles = useEnvironmentScope(member.environmentId, AuthFilesystemReadScope);
  // Read from disk: the project's own copy of the list can be a moment behind a clone.
  const listQuery = useEnvironmentQuery(
    canReadFiles
      ? filesystemEnvironment.listFolders({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        })
      : null,
  );
  const folders: ReadonlyArray<ProjectTrackedFolder & { state?: WorkspaceFolderState }> =
    listQuery.data?.folders ?? tracked;
  // Only a workspace file's folders are offered: the rest is found without asking.
  const scanQuery = useEnvironmentQuery(
    canReadFiles
      ? filesystemEnvironment.scanFolders({
          environmentId: member.environmentId,
          input: { workspaceRoot: member.workspaceRoot },
        })
      : null,
  );
  const suggested = suggestedTrackedFolders(folders, scanQuery.data?.folders ?? []);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [isSaving, setIsSaving] = useState(false);
  // A save builds on the listed folders, so it waits for the list that follows the last one.
  const isBusy = isSaving || listQuery.isPending;
  const added = folders.filter((folder) => folder.discovered !== true);

  // One folder in or out: the server applies it to its own list, which another client may have
  // changed while a confirmation was open here.
  const save = async (
    change: { readonly track: ProjectTrackedFolder } | { readonly untrack: string },
  ) => {
    setIsSaving(true);
    const result = await updateProject({
      environmentId: member.environmentId,
      input: {
        projectId: member.id,
        ...("track" in change
          ? { trackFolders: [{ path: change.track.path, name: change.track.name }] }
          : { untrackFolders: [change.untrack] }),
      },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          t("Failed to update repositories"),
          error instanceof Error ? error.message : t("An error occurred."),
        );
      }
      return;
    }
    listQuery.refresh();
  };

  const remove = (folder: ProjectTrackedFolder) =>
    Dialog.confirm({
      title: t("Remove folder"),
      message: t("Agents in this project stop working in {name}. Files on disk are not touched.", {
        name: folder.name,
      }),
      confirmText: t("Remove"),
      destructive: true,
      onConfirm: () => void save({ untrack: folder.path }),
    });

  const add = (folder: ProjectTrackedFolder) => {
    const next = appendTrackedFolders(added, [folder]);
    if (next === null) {
      Dialog.alert(
        t("Too many folders"),
        t("A project can cover up to {max} folders.", { max: PROJECT_TRACKED_FOLDERS_MAX }),
      );
      return;
    }
    void save({ track: folder });
  };

  if (folders.length === 0 && suggested.length === 0) {
    return (
      <SettingsSection
        title={props.title}
        footer={t(
          "Repositories inside this project's folder are part of it as soon as they are there.",
        )}
      >
        {null}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={props.title}>
      {folders.map((folder) => (
        <ListRowLayout
          key={folder.path}
          icon="folder"
          label={folder.name}
          description={folder.path}
          meta={
            folder.state === undefined ? undefined : (
              <Text
                textRole="footnote"
                className={
                  folder.state === "missing" ? "text-warning-foreground" : "text-foreground-muted"
                }
              >
                {t(FOLDER_STATE_LABELS[folder.state])}
              </Text>
            )
          }
          accessory={
            // A repository inside the project folder is there for as long as it is on disk.
            folder.discovered === true ? undefined : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Remove {name} from the project", { name: folder.name })}
                disabled={!canEdit || isBusy}
                onPress={() => remove(folder)}
                className="rounded-full border border-border bg-card px-3 py-1.5 disabled:opacity-40"
              >
                <Text className="font-t3-medium text-xs text-danger-foreground">{t("Remove")}</Text>
              </Pressable>
            )
          }
        />
      ))}
      {suggested.map((folder) => (
        <ListActionRow
          key={folder.path}
          icon="plus"
          label={t("Add {name}", { name: folder.name })}
          description={t("Listed in the workspace file · {path}", { path: folder.path })}
          disabled={!canEdit || isBusy}
          onPress={() => add(folder)}
        />
      ))}
    </SettingsSection>
  );
}
