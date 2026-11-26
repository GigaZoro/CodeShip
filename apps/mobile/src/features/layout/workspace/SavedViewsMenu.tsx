import { t } from "../../../lib/i18n";
import { useAtomValue } from "@effect/atom-react";
import {
  type SavedViewIdentity as SavedViewIdentitySchema,
  savedViewNameError,
} from "@t3tools/client-runtime/saved-views";

import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert } from "react-native";

import { prompt as showTextInputDialog } from "../../../components/ui/Dialog";
import type { MenuProps } from "../../../components/ui/Menu.types";
import { uuidv4 } from "../../../lib/uuid";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../state/preferences";
import { useAtomCommand } from "../../../state/use-atom-command";
import { ListFilterMenu } from "./ListFilterMenu";

type SavedViewIdentity = typeof SavedViewIdentitySchema.Type;
const EMPTY_SAVED_VIEWS: ReadonlyArray<never> = [];

export function SavedViewsMenu<Scope extends object>({
  read,
  write,
  list,
  suggestedName,
  scope,
  matches,
  onApply,
}: {
  read: (preferences: Preferences) => ReadonlyArray<Scope & SavedViewIdentity> | undefined;
  write: (views: ReadonlyArray<Scope & SavedViewIdentity>) => Partial<Preferences>;
  /** Picks whole translated sentences for this list; never inject it into copy. */
  list: "pullRequest" | "issue";
  suggestedName: string;
  scope: Scope;
  matches: (view: Scope, scope: Scope) => boolean;
  onApply: (view: Scope & SavedViewIdentity) => Promise<void> | void;
}) {
  type View = Scope & SavedViewIdentity;

  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences, { reportFailure: false });
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const views: ReadonlyArray<View> = AsyncResult.isSuccess(preferences)
    ? (read(preferences.value) ?? EMPTY_SAVED_VIEWS)
    : EMPTY_SAVED_VIEWS;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedView =
    views.find((view) => view.id === selectedId) ?? views.find((view) => matches(view, scope));
  if (selectedId === null && selectedView) setSelectedId(selectedView.id);
  const modified = selectedView !== undefined && !matches(selectedView, scope);

  // These avoid `finally`, which the React Compiler cannot lower; every path clears `busy`.
  async function applyView(view: View) {
    setBusy(true);
    try {
      await onApply(view);
      setSelectedId(view.id);
    } catch {
      Alert.alert(
        list === "pullRequest" ? t("Could not apply PR view") : t("Could not apply issue view"),
        t("The device could not save your filters. Try again."),
      );
    }
    setBusy(false);
  }

  async function persist(transform: (current: ReadonlyArray<View>) => ReadonlyArray<View>) {
    setBusy(true);
    const saved =
      (
        await savePreferences({
          transform: (current) => write(transform(read(current) ?? EMPTY_SAVED_VIEWS)),
        })
      )._tag === "Success";
    if (!saved) {
      Alert.alert(
        list === "pullRequest" ? t("Could not save PR views") : t("Could not save issue views"),
        t("The device could not save your views. Try again."),
      );
    }
    setBusy(false);
    return saved;
  }

  function editName(view?: View) {
    showTextInputDialog({
      title: view
        ? list === "pullRequest"
          ? t("Rename PR view")
          : t("Rename issue view")
        : list === "pullRequest"
          ? t("Save PR view")
          : t("Save issue view"),
      initialValue: view?.name ?? suggestedName,
      confirmText: t("Save"),
      onConfirm: (value) => {
        const error = savedViewNameError(value, views, view?.id, t);
        if (error) {
          Alert.alert(t("Could not save view"), error);
          return;
        }
        const id = view?.id ?? uuidv4();
        const name = value.trim();
        void persist((current) =>
          view
            ? current.map((item) => (item.id === view.id ? { ...item, name } : item))
            : [...current, { ...scope, id, name }],
        ).then((saved) => {
          if (saved) setSelectedId(id);
        });
      },
    });
  }

  const actions: MenuProps["actions"] = [
    ...views.map((view) => ({
      id: `apply:${view.id}`,
      title: view.name,
      state: selectedView?.id === view.id && !modified ? ("on" as const) : ("off" as const),
    })),
    { id: "save", title: t("Save current view…") },
    ...(selectedView
      ? [
          ...(modified ? [{ id: "update", title: t("Update saved view") }] : []),
          { id: "rename", title: t("Rename view…") },
          { id: "delete", title: t("Delete view"), attributes: { destructive: true } },
        ]
      : []),
  ];

  return (
    <ListFilterMenu
      label={selectedView ? `${selectedView.name}${modified ? " *" : ""}` : t("Views")}
      active={selectedView !== undefined}
      accessibilityLabel={
        list === "pullRequest" ? t("Saved pull request views") : t("Saved issue views")
      }
      actions={actions.map((action) => ({
        ...action,
        attributes: { ...action.attributes, disabled: !ready || busy },
      }))}
      onSelect={(id) => {
        if (!ready || busy) return;
        const view = views.find((item) => `apply:${item.id}` === id);
        if (view) {
          void applyView(view);
          return;
        }
        if (id === "save") editName();
        else if (id === "rename" && selectedView) editName(selectedView);
        else if (id === "update" && selectedView)
          void persist((current) =>
            current.map((item) => (item.id === selectedView.id ? { ...item, ...scope } : item)),
          );
        else if (id === "delete" && selectedView)
          void persist((current) => current.filter((item) => item.id !== selectedView.id)).then(
            (saved) => {
              if (saved) setSelectedId(null);
            },
          );
      }}
    />
  );
}
