import { msg, t, tx, type Message } from "~/i18n";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectScript,
  type ProjectScriptIcon,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProjectScriptShortcutError,
  type ProjectScriptSaveInput,
  type ProjectScriptSaveResult,
} from "@t3tools/client-runtime/state/projectScriptSaves";
import { keybindingValueForCommand, parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import {
  commandForProjectScript,
  decodeProjectScriptKeybindingRule,
  EMPTY_PROJECT_SCRIPT_INPUT as EMPTY_SCRIPT_INPUT,
  nextProjectScriptId,
  projectScriptInputFromScript,
} from "@t3tools/shared/projectScripts";
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import {
  buildKeybindingRows,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
} from "~/components/settings/KeybindingsSettings.logic";
import { formatShortcutLabel } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./chat/useComposerMenuState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: Message }> = [
  { id: "play", label: msg("Play") },
  { id: "test", label: msg("Test") },
  { id: "lint", label: msg("Lint") },
  { id: "configure", label: msg("Configure") },
  { id: "build", label: msg("Build") },
  { id: "debug", label: msg("Debug") },
];

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export const EMPTY_PROJECT_SCRIPT_INPUT: ProjectScriptSaveInput = {
  ...EMPTY_SCRIPT_INPUT,
  keybinding: null,
};

export interface ProjectScriptEditorRequest {
  scriptId: string | null;
  initial: ProjectScriptSaveInput;
  error?: string;
}

interface EditorError {
  readonly message: string;
  readonly field: "name" | "command" | "keybinding" | null;
}

interface SavedScript {
  readonly id: string;
  readonly name: string;
}

export function editorRequestForScript(
  script: ProjectScript,
  keybindings: ResolvedKeybindingsConfig,
): ProjectScriptEditorRequest {
  return {
    scriptId: script.id,
    initial: {
      ...projectScriptInputFromScript(script),
      keybinding: keybindingValueForCommand(keybindings, commandForProjectScript(script.id)),
    },
  };
}

export function ProjectScriptEditorDialog({
  environmentId,
  editScope = AuthOrchestrationOperateScope,
  request,
  scripts,
  keybindings,
  onSubmit,
  onDelete,
  onClose,
}: {
  environmentId: EnvironmentId;
  editScope?: typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope;
  request: ProjectScriptEditorRequest | null;
  scripts: ReadonlyArray<ProjectScript>;
  keybindings: ResolvedKeybindingsConfig;
  onSubmit: (
    scriptId: string | null,
    input: ProjectScriptSaveInput,
  ) => Promise<ProjectScriptSaveResult>;
  onDelete: (scriptId: string) => void;
  onClose: () => void;
}) {
  const canEditActions = useEnvironmentScope(environmentId, editScope);
  // Scope errors and saves by request so a late save cannot touch a newer request.
  const [errorState, setErrorState] = useState<{
    readonly request: ProjectScriptEditorRequest;
    readonly error: EditorError | null;
  } | null>(null);
  const validationError: EditorError | null =
    request === null
      ? null
      : errorState?.request === request
        ? errorState.error
        : request.error
          ? { message: request.error, field: null }
          : null;
  const setValidationError = (error: EditorError | null) => {
    if (request !== null) setErrorState({ request, error });
  };
  const [savingRequest, setSavingRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const isSaving = request !== null && savingRequest === request;
  // The last opened request stays shown while the dialog animates closed. Each
  // new request mounts a fresh form, which drops the previous request's save.
  const [shown, setShown] = useState<{
    readonly request: ProjectScriptEditorRequest;
    readonly key: number;
  } | null>(request === null ? null : { request, key: 0 });
  if (request !== null && request !== shown?.request) {
    setShown({ request, key: (shown?.key ?? 0) + 1 });
  }
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useComposerMenuState(!canEditActions);
  const [deleteTarget, setDeleteTarget] = useState<SavedScript | null>(null);

  return (
    <>
      <Dialog
        open={request !== null}
        disablePointerDismissal
        onOpenChange={(open) => {
          if (!open && !isSaving) onClose();
        }}
      >
        {/* The form owns its fields so a keystroke re-renders it, not the dialog chrome. */}
        <DialogPopup>
          {shown ? (
            <ProjectScriptEditorForm
              key={shown.key}
              environmentId={environmentId}
              editScope={editScope}
              request={shown.request}
              scripts={scripts}
              keybindings={keybindings}
              isSaving={savingRequest === shown.request}
              validationError={validationError}
              onValidationError={setValidationError}
              onSavingChange={(target, saving) =>
                setSavingRequest((current) =>
                  saving ? target : current === target ? null : current,
                )
              }
              onSubmit={onSubmit}
              onRequestDelete={(script) => {
                setDeleteTarget(script);
                setDeleteConfirmOpen(true);
              }}
              onClose={onClose}
            />
          ) : null}
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen && canEditActions} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Delete action "{name}"?', { name: deleteTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("This action cannot be undone.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!canEditActions}
              onClick={() => {
                if (!deleteTarget) return;
                if (!readEnvironmentScope(environmentId, editScope)) {
                  setValidationError({
                    message: t("This connection cannot change project actions."),
                    field: null,
                  });
                  return;
                }
                setDeleteConfirmOpen(false);
                onClose();
                onDelete(deleteTarget.id);
              }}
            >
              {t("Delete action")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function FieldError({ id, error }: { id: string; error: EditorError | null }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive-foreground">
      {error.message}
    </p>
  );
}

function conflictMessage(labels: ReadonlyArray<string>): string | null {
  if (labels.length === 0) return null;
  return labels.length > 3
    ? t("Conflicts with {commands}, and more.", { commands: labels.slice(0, 3).join(", ") })
    : t("Conflicts with {commands}.", { commands: labels.join(", ") });
}

function ProjectScriptEditorForm({
  environmentId,
  editScope,
  request,
  scripts,
  keybindings,
  isSaving,
  validationError,
  onValidationError: setValidationError,
  onSavingChange,
  onSubmit,
  onRequestDelete,
  onClose,
}: {
  environmentId: EnvironmentId;
  editScope: typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope;
  request: ProjectScriptEditorRequest;
  scripts: ReadonlyArray<ProjectScript>;
  keybindings: ResolvedKeybindingsConfig;
  isSaving: boolean;
  validationError: EditorError | null;
  onValidationError: (error: EditorError | null) => void;
  onSavingChange: (request: ProjectScriptEditorRequest, saving: boolean) => void;
  onSubmit: (
    scriptId: string | null,
    input: ProjectScriptSaveInput,
  ) => Promise<ProjectScriptSaveResult>;
  onRequestDelete: (script: SavedScript) => void;
  onClose: () => void;
}) {
  const canEditActions = useEnvironmentScope(environmentId, editScope);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const formId = React.useId();
  const [savedScript, setSavedScript] = useState<SavedScript | null>(
    request.scriptId === null ? null : { id: request.scriptId, name: request.initial.name },
  );
  const [name, setName] = useState(request.initial.name);
  const [command, setCommand] = useState(request.initial.command);
  const [icon, setIcon] = useState<ProjectScriptIcon>(request.initial.icon);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditActions);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(
    request.initial.runOnWorktreeCreate,
  );
  const [waitForSetup, setWaitForSetup] = useState(request.initial.waitForSetup);
  const [runOnSettle, setRunOnSettle] = useState(request.initial.runOnSettle);
  const [keybinding, setKeybinding] = useState(request.initial.keybinding ?? "");
  const [previewUrl, setPreviewUrl] = useState(request.initial.previewUrl ?? "");
  const [autoOpenPreview, setAutoOpenPreview] = useState(request.initial.autoOpenPreview);
  const pendingSubmissionRef = useRef<object | null>(null);
  // A save that settles after this form is replaced must not close or error
  // the request that replaced it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the pending save on unmount so a late result cannot close or fail the next request
  useEffect(
    () => () => {
      pendingSubmissionRef.current = null;
    },
    [],
  );

  const scriptId = savedScript?.id ?? null;
  const isEditing = scriptId !== null;
  const changesKeybinding =
    (keybinding.trim() || null) !== (request.initial.keybinding?.trim() || null);
  const ownCommand = scriptId === null ? null : commandForProjectScript(scriptId);
  const keybindingRows = buildKeybindingRows(keybindings);
  const keybindingConflict = changesKeybinding
    ? conflictMessage(
        keybindingConflictLabels(
          keybindingRows.filter((row) => row.command !== ownCommand),
          { rowId: "", key: keybinding, when: "" },
        ),
      )
    : null;
  const keybindingError: EditorError | null = keybindingConflict
    ? { message: keybindingConflict, field: "keybinding" }
    : validationError?.field === "keybinding"
      ? validationError
      : null;
  const fieldError = (field: EditorError["field"]) =>
    validationError?.field === field ? validationError : null;
  const keybindingShortcut = keybinding ? parseKeybindingShortcut(keybinding) : null;
  const setupHolder = scripts.find(
    (script) => script.id !== scriptId && script.runOnWorktreeCreate,
  );
  const settleHolder = scripts.find((script) => script.id !== scriptId && script.runOnSettle);
  const errorId = (field: string) => `${formId}-${field}-error`;

  const clearError = (field: EditorError["field"]) => {
    if (validationError?.field === field) setValidationError(null);
  };

  const close = () => {
    pendingSubmissionRef.current = null;
    onSavingChange(request, false);
    setIconPickerOpen(false);
    onClose();
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
    // Tab moves focus, Escape closes the dialog and Enter saves, as in every other field.
    if (event.key === "Tab" || event.key === "Escape") return;
    if (event.key === "Enter" && !hasModifier && !event.shiftKey) return;
    event.preventDefault();
    if (!readEnvironmentScope(environmentId, editScope)) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    if (!hasModifier && (event.key === "Backspace" || event.key === "Delete")) {
      setKeybinding("");
      clearError("keybinding");
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!next) return;
    if (!hasModifier && !/^F\d{1,2}$/.test(event.key)) {
      setValidationError({
        message: t("Add a modifier key, such as {modifier} or Alt.", {
          modifier: isMacPlatform(navigator.platform) ? "⌘" : "Ctrl",
        }),
        field: "keybinding",
      });
      return;
    }
    setKeybinding(next);
    clearError("keybinding");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pendingSubmissionRef.current !== null) return;
    if (!readEnvironmentScope(environmentId, editScope)) {
      setValidationError({
        message: t("This connection cannot change project actions."),
        field: null,
      });
      return;
    }
    const canChangeKeybinding = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
    if (changesKeybinding && !canChangeKeybinding) {
      setValidationError({
        message: t("This connection cannot change keyboard shortcuts."),
        field: "keybinding",
      });
      return;
    }
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError({ message: t("Name is required."), field: "name" });
      return;
    }
    if (
      scripts.some(
        (script) =>
          script.id !== scriptId && script.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      )
    ) {
      setValidationError({
        message: t('An action named "{name}" already exists.', { name: trimmedName }),
        field: "name",
      });
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError({ message: t("Command is required."), field: "command" });
      return;
    }
    if (keybindingConflict) return;

    setValidationError(null);
    let payload: ProjectScriptSaveInput;
    try {
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(
          scriptId ??
            nextProjectScriptId(
              trimmedName,
              scripts.map((script) => script.id),
            ),
        ),
      });
      const trimmedPreviewUrl = previewUrl.trim();
      payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        waitForSetup: runOnWorktreeCreate && waitForSetup,
        runOnSettle,
        ...((scriptId === null && canChangeKeybinding) || changesKeybinding
          ? { keybinding: keybindingRule?.key ?? null }
          : {}),
        previewUrl: trimmedPreviewUrl.length > 0 ? trimmedPreviewUrl : null,
        autoOpenPreview: trimmedPreviewUrl.length > 0 ? autoOpenPreview : false,
      } satisfies ProjectScriptSaveInput;
    } catch (error) {
      setValidationError({
        message: error instanceof Error ? error.message : t("Failed to save action."),
        field: "keybinding",
      });
      return;
    }

    const submission = {};
    pendingSubmissionRef.current = submission;
    onSavingChange(request, true);
    setIconPickerOpen(false);
    try {
      const result = await onSubmit(scriptId, payload);
      if (pendingSubmissionRef.current === submission) {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            if (error instanceof ProjectScriptShortcutError) {
              setSavedScript({ id: error.scriptId, name: payload.name });
            }
            setValidationError({
              message: error instanceof Error ? error.message : t("Failed to save action."),
              field: error instanceof ProjectScriptShortcutError ? "keybinding" : null,
            });
          }
        } else {
          close();
        }
      }
    } catch (error) {
      if (pendingSubmissionRef.current === submission) {
        setValidationError({
          message: error instanceof Error ? error.message : t("Failed to save action."),
          field: null,
        });
      }
    }
    if (pendingSubmissionRef.current === submission) {
      pendingSubmissionRef.current = null;
      onSavingChange(request, false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? t("Edit action") : t("Add action")}</DialogTitle>
        <DialogDescription>
          {t(
            "Commands that run in this project's checkout or its worktree, with optional shortcuts.",
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {!canEditActions && (
          <p className="mb-4 text-sm text-muted-foreground">
            {t("This connection cannot change project actions.")}
          </p>
        )}
        <form id={formId} onSubmit={submit}>
          <fieldset className="space-y-4" disabled={isSaving || !canEditActions}>
            <div className="space-y-1.5">
              <Label htmlFor="script-name">{t("Name")}</Label>
              <div className="flex items-center gap-2">
                <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="size-9 shrink-0"
                        aria-label={t("Choose icon")}
                      />
                    }
                  >
                    <ScriptIcon icon={icon} className="size-4.5" />
                  </PopoverTrigger>
                  <PopoverPopup align="start">
                    <div className="grid grid-cols-3 gap-2">
                      {SCRIPT_ICONS.map((entry) => {
                        const isSelected = entry.id === icon;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs dark:border-transparent ${
                              isSelected
                                ? "border-primary/70 bg-primary/10 ring-inset dark:ring-1 dark:ring-primary/30"
                                : "border-border/70 hover:bg-accent/60 dark:bg-white/[0.035]"
                            }`}
                            onClick={() => {
                              setIcon(entry.id);
                              setIconPickerOpen(false);
                            }}
                          >
                            <ScriptIcon icon={entry.id} className="size-4" />
                            <span>{t(entry.label)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverPopup>
                </Popover>
                <Input
                  id="script-name"
                  autoFocus
                  placeholder={t("Test")}
                  value={name}
                  aria-invalid={fieldError("name") ? true : undefined}
                  aria-describedby={fieldError("name") ? errorId("name") : undefined}
                  onChange={(event) => {
                    setName(event.target.value);
                    clearError("name");
                  }}
                />
              </div>
              <FieldError id={errorId("name")} error={fieldError("name")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-keybinding">{t("Keybinding")}</Label>
              <Input
                disabled={!canWriteSettings}
                id="script-keybinding"
                placeholder={t("Press shortcut")}
                value={keybindingShortcut ? formatShortcutLabel(keybindingShortcut) : keybinding}
                readOnly
                aria-invalid={keybindingError ? true : undefined}
                aria-describedby={`${formId}-keybinding-hint${keybindingError ? ` ${errorId("keybinding")}` : ""}`}
                onKeyDown={captureKeybinding}
              />
              <FieldError id={errorId("keybinding")} error={keybindingError} />
              <p id={`${formId}-keybinding-hint`} className="text-xs text-muted-foreground">
                {canWriteSettings
                  ? tx(
                      "Press a shortcut. Use {key} to clear. Shortcuts are environment-wide. Projects using the same action share its shortcut.",
                      { key: <code>{"Backspace"}</code> },
                    )
                  : t("This connection cannot change keyboard shortcuts.")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-command">{t("Command")}</Label>
              <Textarea
                id="script-command"
                placeholder={"bun test"}
                value={command}
                aria-invalid={fieldError("command") ? true : undefined}
                aria-describedby={fieldError("command") ? errorId("command") : undefined}
                onChange={(event) => {
                  setCommand(event.target.value);
                  clearError("command");
                }}
              />
              <FieldError id={errorId("command")} error={fieldError("command")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-preview-url">{t("Preview URL (optional)")}</Label>
              <Input
                id="script-preview-url"
                placeholder={"http://localhost:5173"}
                value={previewUrl}
                onChange={(event) => setPreviewUrl(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Open this URL in the in-app preview when this action runs. The preview is only in the desktop app.",
                )}
              </p>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span className="flex min-w-0 flex-col">
                <span>{t("Run automatically on worktree creation")}</span>
                {runOnWorktreeCreate && setupHolder ? (
                  <span className="text-xs text-muted-foreground">
                    {t("Replaces {name}", { name: setupHolder.name })}
                  </span>
                ) : null}
              </span>
              <Switch
                checked={runOnWorktreeCreate}
                onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
              />
            </label>
            <label
              className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                runOnWorktreeCreate ? "" : "opacity-60"
              }`}
            >
              <span>{t("Wait for it to finish before the agent starts")}</span>
              <Switch
                checked={waitForSetup}
                disabled={!runOnWorktreeCreate}
                onCheckedChange={(checked) => setWaitForSetup(Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span className="flex min-w-0 flex-col">
                <span>{t("Run in the thread's worktree when the thread settles")}</span>
                {runOnSettle && settleHolder ? (
                  <span className="text-xs text-muted-foreground">
                    {t("Replaces {name}", { name: settleHolder.name })}
                  </span>
                ) : null}
              </span>
              <Switch
                checked={runOnSettle}
                onCheckedChange={(checked) => setRunOnSettle(Boolean(checked))}
              />
            </label>
            <label
              className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                previewUrl.trim().length === 0 ? "opacity-60" : ""
              }`}
            >
              <span>{t("Open preview automatically when this action runs")}</span>
              <Switch
                checked={autoOpenPreview}
                disabled={previewUrl.trim().length === 0}
                onCheckedChange={(checked) => setAutoOpenPreview(Boolean(checked))}
              />
            </label>
            <FieldError id={errorId("form")} error={fieldError(null)} />
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        {savedScript && (
          <Button
            type="button"
            variant="destructive-outline"
            className="sm:mr-auto"
            disabled={isSaving || !canEditActions}
            onClick={() => onRequestDelete(savedScript)}
          >
            {t("Delete")}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={isSaving} onClick={close}>
          {t("Cancel")}
        </Button>
        <Button form={formId} type="submit" disabled={isSaving || !canEditActions}>
          {isSaving ? t("Saving…") : isEditing ? t("Save changes") : t("Save action")}
        </Button>
      </DialogFooter>
    </>
  );
}
