import { t } from "~/i18n";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectScript,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ProjectScriptSaveInput,
  ProjectScriptSaveResult,
} from "@t3tools/client-runtime/state/projectScriptSaves";
import {
  commandForProjectScript,
  primaryProjectScript,
  projectScriptMenuLabel,
} from "@t3tools/shared/projectScripts";
import { ChevronDownIcon, DownloadIcon, PlusIcon, SettingsIcon, WrenchIcon } from "lucide-react";
import { useRef, useState } from "react";

import { shortcutLabelForCommand } from "~/keybindings";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";

const NO_FILE_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

interface ProjectScriptsControlProps {
  environmentId: EnvironmentId;
  scripts: ReadonlyArray<ProjectScript>;
  fileScripts?: ReadonlyArray<T3ProjectFileScript>;
  preferredScriptId?: string | null;
  /** Omitted when this client cannot run terminal commands. */
  onRunScript?: ((script: ProjectScript) => void) | undefined;
  onAddScript: (input: ProjectScriptSaveInput) => Promise<ProjectScriptSaveResult>;
  onUpdateScript: (
    scriptId: string,
    input: ProjectScriptSaveInput,
  ) => Promise<ProjectScriptSaveResult>;
  onDeleteScript: (scriptId: string) => Promise<ProjectScriptSaveResult>;
}

export default function ProjectScriptsControl({
  environmentId,
  scripts,
  fileScripts = NO_FILE_SCRIPTS,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const keybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);

  const primaryScript =
    (preferredScriptId ? scripts.find((script) => script.id === preferredScriptId) : undefined) ??
    primaryProjectScript(scripts);
  const importableScripts = fileScripts.filter(
    (fileScript) =>
      !scripts.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );
  const roleLabels = { setup: t("setup"), settle: t("on settle") };

  const openAddDialog = () => {
    setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT });
  };

  const submitScript = (scriptId: string | null, input: ProjectScriptSaveInput) =>
    scriptId === null ? onAddScript(input) : onUpdateScript(scriptId, input);

  const importFileScript = async (fileScript: T3ProjectFileScript) => {
    const payload: ProjectScriptSaveInput = {
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
      runOnSettle: fileScript.runOnSettle ?? false,
      ...(readEnvironmentScope(environmentId, AuthSettingsWriteScope) ? { keybinding: null } : {}),
      previewUrl: fileScript.previewUrl ?? null,
      autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
    };
    const result = await onAddScript(payload);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setEditorRequest({
        scriptId: null,
        initial: payload,
        error: error instanceof Error ? error.message : t("Failed to import action."),
      });
    }
  };

  const menuItems = (
    <>
      {scripts.map((script) => {
        const shortcutLabel = shortcutLabelForCommand(
          keybindings,
          commandForProjectScript(script.id),
        );
        return (
          <MenuItem key={script.id} disabled={!onRunScript} onClick={() => onRunScript?.(script)}>
            <ScriptIcon icon={script.icon} className="size-4" />
            <MenuItemLabel>{projectScriptMenuLabel(script, roleLabels)}</MenuItemLabel>
            {shortcutLabel ? <MenuShortcut>{shortcutLabel}</MenuShortcut> : null}
          </MenuItem>
        );
      })}
      {importableScripts.length > 0 && (
        <>
          {scripts.length > 0 && <MenuSeparator />}
          <MenuGroup>
            <MenuGroupLabel>{t("From t3.json")}</MenuGroupLabel>
            {importableScripts.map((fileScript) => (
              <MenuItem
                key={`${fileScript.name} ${fileScript.command}`}
                onClick={() => void importFileScript(fileScript)}
              >
                <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4" />
                <MenuItemLabel>{fileScript.name}</MenuItemLabel>
                <MenuShortcut>
                  <DownloadIcon className="size-3.5" aria-label={t("Import")} />
                </MenuShortcut>
              </MenuItem>
            ))}
          </MenuGroup>
        </>
      )}
      <MenuSeparator />
      {scripts.length > 0 && (
        <MenuSub>
          <MenuSubTrigger>
            <SettingsIcon className="size-4" />
            <MenuItemLabel>{t("Edit action")}</MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>
            {scripts.map((script) => (
              <MenuItem
                key={script.id}
                onClick={() => setEditorRequest(editorRequestForScript(script, keybindings))}
              >
                <ScriptIcon icon={script.icon} className="size-4" />
                <MenuItemLabel>{script.name}</MenuItemLabel>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      )}
      <MenuItem onClick={openAddDialog}>
        <PlusIcon className="size-4" />
        <MenuItemLabel>{t("Add action")}</MenuItemLabel>
      </MenuItem>
    </>
  );

  return (
    <>
      {primaryScript ? (
        <div
          role="group"
          aria-label={t("Project actions")}
          className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
          ref={anchorRef}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="primary"
                  aria-label={t("Run {name}", { name: primaryScript.name })}
                  aria-disabled={!onRunScript || undefined}
                  onClick={() => onRunScript?.(primaryScript)}
                />
              }
            >
              <ScriptIcon icon={primaryScript.icon} className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                {primaryScript.name}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              {onRunScript
                ? t("Run {name}", { name: primaryScript.name })
                : t("Pair this client again with permission to run terminal commands.")}
            </TooltipPopup>
          </Tooltip>
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="secondary"
                  aria-label={t("More project actions")}
                />
              }
            >
              <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
            </MenuTrigger>
            <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
              {menuItems}
            </MenuPopup>
          </Menu>
        </div>
      ) : scripts.length > 0 || importableScripts.length > 0 ? (
        <div
          role="group"
          aria-label={t("Project actions")}
          className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
          ref={anchorRef}
        >
          <ThreadDetailsControl
            size="sm"
            variant="ghost"
            part="primary"
            aria-label={t("Project actions")}
            onClick={() => setMenuOpen(true)}
          >
            <WrenchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              {t("Actions")}
            </span>
          </ThreadDetailsControl>
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          <Menu highlightItemOnHover={false} open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="secondary"
                  aria-label={t("Choose project action")}
                />
              }
            >
              <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
            </MenuTrigger>
            <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
              {menuItems}
            </MenuPopup>
          </Menu>
        </div>
      ) : (
        <ThreadDetailsControl size="xs" variant="ghost" part="row" onClick={openAddDialog}>
          <PlusIcon className="size-3.5" />
          <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{t("Add action")}</span>
        </ThreadDetailsControl>
      )}

      <ProjectScriptEditorDialog
        environmentId={environmentId}
        request={editorRequest}
        scripts={scripts}
        keybindings={keybindings}
        onSubmit={submitScript}
        onDelete={(scriptId) => void onDeleteScript(scriptId)}
        onClose={() => setEditorRequest(null)}
      />
    </>
  );
}
