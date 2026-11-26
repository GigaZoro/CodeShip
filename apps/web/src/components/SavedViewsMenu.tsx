import { type Message, t } from "~/i18n";

import { BookmarkIcon, CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import type * as Schema from "effect/Schema";
import {
  SAVED_VIEW_NAME_MAX_LENGTH,
  savedViewNameError,
} from "@t3tools/client-runtime/saved-views";

import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";
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
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

export interface SavedView<Preferences> {
  readonly id: string;
  readonly name: string;
  readonly preferences: Preferences;
}

/**
 * What one list (pull requests, issues) stores and how it compares its list controls. `Stored`
 * is the schema's decoded shape, which may spell absent fields as `undefined`.
 */
export interface SavedViewsKind<Preferences extends Stored, Stored, Encoded> {
  readonly storageKey: string;
  readonly schema: Schema.Codec<ReadonlyArray<SavedView<Stored>>, Encoded>;
  readonly empty: ReadonlyArray<SavedView<Stored>>;
  /** Picks whole translated sentences for this list; never inject it into copy. */
  readonly list: "pullRequest" | "issue";
  /** `msg()` text, resolved where it renders. */
  readonly placeholder: Message;
  /** `msg()` text or "". */
  readonly suggestedName: (preferences: Preferences) => Message | "";
  /** Drops the parts of the list state that a view does not keep. */
  readonly normalize: (preferences: Stored) => Preferences;
  readonly matches: (view: SavedView<Stored>, preferences: Preferences) => boolean;
}

export function SavedViewsMenu<Preferences extends Stored, Stored, Encoded>({
  kind,
  preferences,
  onApply,
}: {
  kind: SavedViewsKind<Preferences, Stored, Encoded>;
  preferences: Preferences;
  onApply: (preferences: Preferences) => void;
}) {
  const [views, setViews] = useLocalStorage(kind.storageKey, kind.empty, kind.schema);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id?: string; name: string } | null>(null);
  const inputId = useId();
  const errorId = useId();
  const selectedView =
    views.find((view) => view.id === selectedId) ??
    views.find((view) => kind.matches(view, preferences));
  if (selectedView && selectedId !== selectedView.id) setSelectedId(selectedView.id);
  const modified = selectedView !== undefined && !kind.matches(selectedView, preferences);
  const nameError = editor ? savedViewNameError(editor.name, views, editor.id, t) : null;
  const savedViewsLabel =
    kind.list === "pullRequest" ? t("Saved pull request views") : t("Saved issue views");

  function persist(
    update: (current: ReadonlyArray<SavedView<Stored>>) => ReadonlyArray<SavedView<Stored>>,
  ) {
    let written: ReadonlyArray<SavedView<Stored>> | undefined;
    setViews((current) => {
      written = update(current);
      return written;
    });
    // The shared hook logs storage failures. Keep the editor open and explain when saving failed.
    try {
      if (
        written &&
        JSON.stringify(getLocalStorageItem(kind.storageKey, kind.schema)) ===
          JSON.stringify(written)
      ) {
        return true;
      }
    } catch {
      // A browser policy can deny reads as well as writes.
    }
    toastManager.add({
      type: "error",
      title:
        kind.list === "pullRequest"
          ? t("Could not save PR views")
          : t("Could not save issue views"),
      description: t(
        "Local storage is unavailable or full. Try again after freeing space or allowing storage.",
      ),
    });
    return false;
  }

  function saveName() {
    if (!editor || nameError) return;
    const id = editor.id ?? randomUUID();
    const name = editor.name.trim();
    const editingId = editor.id;
    let missing = false;
    const saved = persist((current) => {
      if (editingId && !current.some((view) => view.id === editingId)) {
        missing = true;
        return current;
      }
      return editingId
        ? current.map((view) => (view.id === editingId ? { ...view, name } : view))
        : [...current, { id, name, preferences: kind.normalize(preferences) }];
    });
    if (missing) {
      setEditor((current) => (current ? { name: current.name } : null));
      toastManager.add({
        type: "error",
        title: t("This saved view was removed"),
        description: t("Your name has been kept. Save it as a new view or cancel."),
      });
      return;
    }
    if (!saved) return;
    setSelectedId(id);
    setEditor(null);
  }

  return (
    <>
      <Menu>
        <SharedTooltipTrigger
          render={
            <MenuTrigger render={<Button variant="outline" />} aria-label={savedViewsLabel} />
          }
          label={selectedView?.name ?? savedViewsLabel}
        >
          <BookmarkIcon aria-hidden className="size-4" />
          <span className="max-w-40 truncate">{selectedView?.name ?? t("Views")}</span>
          {modified ? <span aria-label={t("Modified view")}>*</span> : null}
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </SharedTooltipTrigger>
        <MenuPopup align="start">
          {views.map((view) => (
            <SharedTooltipTrigger
              key={view.id}
              render={
                <MenuItem
                  onClick={() => {
                    setSelectedId(view.id);
                    onApply(kind.normalize(view.preferences));
                  }}
                />
              }
              label={view.name}
              side="right"
            >
              {selectedView?.id === view.id && !modified ? (
                <CheckIcon aria-hidden />
              ) : (
                <BookmarkIcon aria-hidden />
              )}
              <MenuItemLabel>{view.name}</MenuItemLabel>
            </SharedTooltipTrigger>
          ))}
          {views.length > 0 ? <MenuSeparator /> : null}
          <MenuItem
            onClick={() => {
              const name = kind.suggestedName(preferences);
              setEditor({ name: name ? t(name) : "" });
            }}
          >
            <PlusIcon aria-hidden />
            {t("Save current view…")}
          </MenuItem>
          {selectedView ? (
            <>
              {modified ? (
                <MenuItem
                  onClick={() =>
                    persist((current) =>
                      current.map((view) =>
                        view.id === selectedView.id
                          ? { ...view, preferences: kind.normalize(preferences) }
                          : view,
                      ),
                    )
                  }
                >
                  {t("Update saved view")}
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => setEditor({ id: selectedView.id, name: selectedView.name })}>
                {t("Rename view…")}
              </MenuItem>
              <MenuItem
                variant="destructive"
                onClick={() => {
                  if (persist((current) => current.filter((view) => view.id !== selectedView.id)))
                    setSelectedId(null);
                }}
              >
                {t("Delete view")}
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogPopup>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              saveName();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editor?.id
                  ? kind.list === "pullRequest"
                    ? t("Rename PR view")
                    : t("Rename issue view")
                  : kind.list === "pullRequest"
                    ? t("Save PR view")
                    : t("Save issue view")}
              </DialogTitle>
              <DialogDescription>
                {t("Save your search, filters, and sort order on this device.")}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-2">
                <Label htmlFor={inputId}>{t("View name")}</Label>
                <Input
                  id={inputId}
                  autoFocus
                  value={editor?.name ?? ""}
                  maxLength={SAVED_VIEW_NAME_MAX_LENGTH}
                  placeholder={t(kind.placeholder)}
                  aria-invalid={Boolean(editor?.name && nameError)}
                  aria-describedby={nameError && editor?.name ? errorId : undefined}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, name: event.target.value } : null,
                    )
                  }
                />
                {nameError && editor?.name ? (
                  <p id={errorId} className="text-sm text-destructive-foreground">
                    {nameError}
                  </p>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditor(null)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={nameError !== null}>
                {t("Save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
