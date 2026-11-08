import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { T3ProjectFileScript } from "@t3tools/contracts";
import {
  importableT3ProjectFileScripts,
  projectScriptInputFromT3File,
  projectScriptMenuLabel,
  type ProjectScriptInput,
} from "@t3tools/shared/projectScripts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { t } from "../../../lib/i18n";
import { useT3ProjectFile } from "../../../state/use-t3-project-file";
import { projectScriptMenuIcon } from "../../terminal/terminalMenu";
import { useProjectActions } from "../useProjectActions";
import { SettingsSection } from "./SettingsSection";

/** Settings → Projects → Actions: the checkouts' action list, as on web. */
export function ProjectActionsSection(props: { readonly members: readonly EnvironmentProject[] }) {
  const navigation = useNavigation();
  const targets = props.members.map((member) => ({
    environmentId: member.environmentId,
    projectId: member.id,
  }));
  const actions = useProjectActions(targets);
  const t3File = useT3ProjectFile(props.members[0] ?? null);
  const importable = importableT3ProjectFileScripts(t3File.file?.scripts ?? [], actions.scripts);
  // t3.json is parsed again each render, so rows are matched by content, not identity.
  const importKey = (fileScript: T3ProjectFileScript) =>
    `${fileScript.name}\n${fileScript.command}`;
  const [importing, setImporting] = useState<string | null>(null);
  const editable = actions.readOnlyReason === null && !actions.saving;
  const openEditor = (request: {
    readonly scriptId: string | null;
    readonly initial?: ProjectScriptInput;
    readonly error?: string;
  }) =>
    navigation.navigate("SettingsProjectAction", {
      targets: targets.map((target) => ({
        environmentId: String(target.environmentId),
        projectId: String(target.projectId),
      })),
      ...request,
    });
  // Like web, an import saves at once; a refused one opens in the editor with its reason.
  const importScript = async (fileScript: T3ProjectFileScript) => {
    const initial = projectScriptInputFromT3File(fileScript);
    setImporting(importKey(fileScript));
    const result = await actions.save(null, initial);
    setImporting(null);
    if (!result.ok && result.message !== null) {
      openEditor({ scriptId: null, initial, error: result.message });
    }
  };
  const roleLabels = { setup: t("setup"), settle: t("on settle") };

  return (
    <SettingsSection
      title={t("Actions")}
      footer={
        actions.readOnlyReason ??
        t(
          "Commands that run in this project's checkout or its worktree, from a thread's terminal menu.",
        )
      }
    >
      {actions.mixed ? (
        <View className="gap-1 px-4 py-3">
          <Text textRole="body" className="text-foreground">
            {t("Different actions across environments")}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {t(
              "Choose one environment to edit its list. Adding an action here adds it on every selected environment.",
            )}
          </Text>
        </View>
      ) : (
        actions.scripts.map((script, index) => (
          <View key={script.id} className={index > 0 ? "border-t border-border-subtle" : undefined}>
            <ListActionRow
              icon={projectScriptMenuIcon(script.icon)}
              label={projectScriptMenuLabel(script, roleLabels)}
              description={script.command}
              // Read-only connections still open it, to read the whole action and why it is locked.
              onPress={() => openEditor({ scriptId: script.id })}
            />
          </View>
        ))
      )}
      {importable.map((fileScript) => (
        <View key={importKey(fileScript)} className="border-t border-border-subtle">
          <ListActionRow
            icon="square.and.arrow.down"
            label={t("Import {name} from t3.json", { name: fileScript.name })}
            description={fileScript.command}
            disabled={!editable}
            loading={importing === importKey(fileScript)}
            onPress={() => void importScript(fileScript)}
          />
        </View>
      ))}
      <View
        className={
          actions.mixed || actions.scripts.length > 0 || importable.length > 0
            ? "border-t border-border-subtle"
            : undefined
        }
      >
        <ListActionRow
          icon="plus"
          label={t("Add action")}
          disabled={!editable}
          onPress={() => openEditor({ scriptId: null })}
        />
      </View>
      {t3File.status === "invalid" ? (
        <View className="gap-1 border-t border-border-subtle px-4 py-3">
          <Text textRole="body" className="text-warning-foreground">
            {t("t3.json is invalid")}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {t(
              "A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values.",
            )}
          </Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}
