import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProjectId, type ProjectScriptIcon } from "@t3tools/contracts";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  projectScriptInputFromScript,
  type ProjectScriptInput,
} from "@t3tools/shared/projectScripts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { msg, t, type Message } from "../../lib/i18n";
import { projectScriptMenuIcon } from "../terminal/terminalMenu";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useProjectActions, type ProjectActionWriteResult } from "./useProjectActions";

const ACTION_ICONS: readonly { readonly id: ProjectScriptIcon; readonly label: Message }[] = [
  { id: "play", label: msg("Play") },
  { id: "test", label: msg("Test") },
  { id: "lint", label: msg("Lint") },
  { id: "configure", label: msg("Configure") },
  { id: "build", label: msg("Build") },
  { id: "debug", label: msg("Debug") },
];

type Props = StaticScreenProps<{
  /** Every checkout the action is written to; Settings passes the selected project's. */
  targets: readonly { readonly environmentId: string; readonly projectId: string }[];
  scriptId: string | null;
  /** Fields for a new action, such as a t3.json import that was refused. */
  initial?: ProjectScriptInput;
  error?: string;
}>;

export function SettingsProjectActionRouteScreen({ route }: Props) {
  const { scriptId, initial, error } = route.params;
  const actions = useProjectActions(
    route.params.targets.map((target) => ({
      environmentId: EnvironmentId.make(target.environmentId),
      projectId: ProjectId.make(target.projectId),
    })),
  );
  const existing =
    scriptId === null ? null : (actions.scripts.find((script) => script.id === scriptId) ?? null);
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={scriptId === null ? t("Add action") : t("Edit action")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {scriptId !== null && existing === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            {actions.readOnlyReason ?? t("Action not found.")}
          </Text>
        ) : (
          <ProjectActionForm
            initial={
              existing
                ? projectScriptInputFromScript(existing)
                : (initial ?? EMPTY_PROJECT_SCRIPT_INPUT)
            }
            initialError={error ?? null}
            scriptId={scriptId}
            actions={actions}
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function ProjectActionForm(props: {
  readonly initial: ProjectScriptInput;
  readonly initialError: string | null;
  readonly scriptId: string | null;
  readonly actions: ReturnType<typeof useProjectActions>;
}) {
  const navigation = useNavigation();
  const { actions } = props;
  const [name, setName] = useState(props.initial.name);
  const [command, setCommand] = useState(props.initial.command);
  const [icon, setIcon] = useState(props.initial.icon);
  const [previewUrl, setPreviewUrl] = useState(props.initial.previewUrl ?? "");
  const [autoOpenPreview, setAutoOpenPreview] = useState(props.initial.autoOpenPreview);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(props.initial.runOnWorktreeCreate);
  const [waitForSetup, setWaitForSetup] = useState(props.initial.waitForSetup);
  const [runOnSettle, setRunOnSettle] = useState(props.initial.runOnSettle);
  const [error, setError] = useState(props.initialError);
  const editable = actions.readOnlyReason === null && !actions.saving;
  const hasPreviewUrl = previewUrl.trim().length > 0;

  const finish = (result: ProjectActionWriteResult) => {
    if (result.ok) {
      navigation.goBack();
      return;
    }
    if (result.message !== null) setError(result.message);
  };

  const save = async () => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) return setError(t("Name is required."));
    if (trimmedCommand.length === 0) return setError(t("Command is required."));
    setError(null);
    const trimmedPreviewUrl = previewUrl.trim();
    finish(
      await actions.save(props.scriptId, {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        waitForSetup: runOnWorktreeCreate && waitForSetup,
        runOnSettle,
        previewUrl: trimmedPreviewUrl.length > 0 ? trimmedPreviewUrl : null,
        autoOpenPreview: trimmedPreviewUrl.length > 0 && autoOpenPreview,
      }),
    );
  };

  const { scriptId } = props;
  const confirmDelete = (deletedId: string) =>
    Dialog.confirm({
      title: t('Delete action "{name}"?', { name: props.initial.name }),
      message: t("This action cannot be undone."),
      confirmText: t("Delete action"),
      destructive: true,
      onConfirm: () => void actions.remove(deletedId).then(finish),
    });

  return (
    <>
      {actions.readOnlyReason !== null ? (
        <View className="flex-row items-start gap-3 px-2">
          <SymbolView
            name={{ ios: "lock", android: "lock" }}
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
          <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
            {actions.readOnlyReason}
          </Text>
        </View>
      ) : null}

      <SettingsSection>
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm font-t3-medium text-foreground-muted">{t("Name")}</Text>
          <AppTextInput
            accessibilityLabel={t("Name")}
            value={name}
            onChangeText={setName}
            placeholder={t("Test")}
            editable={editable}
            autoFocus={props.scriptId === null && props.initial.name === ""}
            returnKeyType="next"
            className="min-h-11 rounded-xl px-3 py-2 text-base text-foreground"
          />
        </View>
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          <Text className="text-sm font-t3-medium text-foreground-muted">{t("Command")}</Text>
          <AppTextInput
            accessibilityLabel={t("Command")}
            value={command}
            onChangeText={setCommand}
            placeholder={"bun test"}
            editable={editable}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            className="min-h-24 rounded-xl px-3 py-2 font-mono text-sm text-foreground"
          />
        </View>
      </SettingsSection>

      <SettingsSection title={t("Choose icon")}>
        <View accessibilityRole="radiogroup" className="flex-row justify-between px-2 py-2">
          {ACTION_ICONS.map((entry) => {
            const selected = entry.id === icon;
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="radio"
                accessibilityLabel={t(entry.label)}
                accessibilityState={{ checked: selected, disabled: !editable }}
                disabled={!editable}
                onPress={() => setIcon(entry.id)}
                className={cn(
                  "size-11 items-center justify-center rounded-xl border-continuous active:opacity-70",
                  selected ? "bg-subtle-strong" : "bg-transparent",
                  !editable && "opacity-45",
                )}
              >
                <SymbolView
                  name={projectScriptMenuIcon(entry.id)}
                  size={22}
                  tintColorClassName={selected ? "accent-foreground" : "accent-icon"}
                  type="monochrome"
                  weight={selected ? "semibold" : "regular"}
                />
              </Pressable>
            );
          })}
        </View>
      </SettingsSection>

      <SettingsSection
        footer={t(
          "Open this URL in the in-app preview when this action runs. The preview is only in the desktop app.",
        )}
      >
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm font-t3-medium text-foreground-muted">
            {t("Preview URL (optional)")}
          </Text>
          <AppTextInput
            accessibilityLabel={t("Preview URL (optional)")}
            value={previewUrl}
            onChangeText={setPreviewUrl}
            placeholder={"http://localhost:5173"}
            editable={editable}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-11 rounded-xl px-3 py-2 text-base text-foreground"
          />
        </View>
        <View className="border-t border-border-subtle">
          <SettingsSwitchRow
            label={t("Open preview automatically when this action runs")}
            value={hasPreviewUrl && autoOpenPreview}
            disabled={!editable || !hasPreviewUrl}
            onValueChange={setAutoOpenPreview}
          />
        </View>
      </SettingsSection>

      <SettingsSection>
        <SettingsSwitchRow
          label={t("Run automatically on worktree creation")}
          value={runOnWorktreeCreate}
          disabled={!editable}
          onValueChange={setRunOnWorktreeCreate}
        />
        <View className="border-t border-border-subtle">
          <SettingsSwitchRow
            label={t("Wait for it to finish before the agent starts")}
            value={runOnWorktreeCreate && waitForSetup}
            disabled={!editable || !runOnWorktreeCreate}
            onValueChange={setWaitForSetup}
          />
        </View>
        <View className="border-t border-border-subtle">
          <SettingsSwitchRow
            label={t("Run in the thread's worktree when the thread settles")}
            value={runOnSettle}
            disabled={!editable}
            onValueChange={setRunOnSettle}
          />
        </View>
      </SettingsSection>

      {error !== null ? (
        <Text accessibilityLiveRegion="polite" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}

      <View className="gap-3">
        <Button
          tone="primary"
          fullWidth
          loading={actions.saving}
          disabled={!editable}
          onPress={() => void save()}
          label={
            actions.saving
              ? t("Saving…")
              : props.scriptId === null
                ? t("Save action")
                : t("Save changes")
          }
        />
        {scriptId !== null ? (
          <Button
            tone="danger"
            fullWidth
            disabled={!editable}
            onPress={() => confirmDelete(scriptId)}
            label={t("Delete action")}
          />
        ) : null}
      </View>
    </>
  );
}
