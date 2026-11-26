import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  parseThreadTag,
  threadTagBlock,
  threadTagMenuEntries,
} from "@t3tools/client-runtime/state/thread-tag-filter";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { RowPressable } from "../../components/ui/RowPressable";
import { Sheet } from "../../components/ui/Sheet";
import { t } from "../../lib/i18n";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export const threadTagPickerTargetAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
);

export function ThreadTagPickerHost() {
  const target = useAtomValue(threadTagPickerTargetAtom);
  const setTarget = useAtomSet(threadTagPickerTargetAtom);
  return target === null ? null : (
    <ThreadTagPicker
      key={scopedThreadKey(target)}
      target={target}
      onClose={() => setTarget(null)}
    />
  );
}

function ThreadTagPicker(props: {
  readonly target: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = props.target;
  const tagsAtom = environmentThreadShells.threadTagsAtom(props.target);
  const tags = useAtomValue(tagsAtom);
  const blockedTagsAtom = serverEnvironment.blockedThreadTagsAtom(environmentId);
  const blockedTags = useAtomValue(blockedTagsAtom);
  const availableTags = useAtomValue(environmentThreadShells.availableThreadTagsAtom);
  const canEditTags = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId, {
      type: "thread.tag.set",
    }),
  );
  const setTag = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const entries = threadTagMenuEntries(availableTags, [{ tags: tags ?? undefined, blockedTags }]);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = pending || !canEditTags || tags === null || entries === null;

  const changeTag = async (value: string, addingNew: boolean) => {
    if (disabled) return;
    const tag = parseThreadTag(value);
    if (tag === null) {
      setError(t("Enter a single line of up to 64 characters."));
      return;
    }
    const tags = appAtomRegistry.get(tagsAtom);
    if (tags === null) return;
    const block = threadTagBlock(
      [{ tags, blockedTags: appAtomRegistry.get(blockedTagsAtom) }],
      tag,
    );
    if (block !== null) {
      setError(
        block === "hidden"
          ? t("That tag is hidden in this environment.")
          : t("Tags are unavailable until this environment's settings load."),
      );
      return;
    }
    setError(null);
    setPending(true);
    const result = await setTag({
      environmentId,
      input: {
        type: "thread.tag.set",
        commandId: CommandId.make(uuidv4()),
        threadId,
        tag,
        tagged: addingNew || !tags.includes(tag),
      },
    }).finally(() => setPending(false));
    if (result._tag === "Success" && addingNew) setDraft(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(t("Failed to update thread tags"));
    }
  };

  return (
    <Sheet title={t("Tags")} onClose={props.onClose}>
      <LegendList
        renderScrollComponent={NativeScrollView}
        data={entries ?? []}
        extraData={disabled}
        estimatedItemSize={48}
        recycleItems
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyExtractor={({ tag }) => tag}
        ListHeaderComponent={
          <View className="gap-2 py-2">
            {draft === null ? (
              <Button
                label={t("Add tag…")}
                icon="plus"
                tone="text"
                onPress={() => setDraft("")}
                disabled={disabled}
              />
            ) : (
              <>
                <AppTextInput
                  accessibilityLabel={t("Add tag")}
                  autoFocus
                  value={draft}
                  onChangeText={setDraft}
                  editable={!disabled}
                  onSubmitEditing={() => void changeTag(draft, true)}
                  returnKeyType="done"
                />
                <View className="flex-row gap-2">
                  <Button
                    label={t("Cancel")}
                    tone="text"
                    onPress={() => setDraft(null)}
                    disabled={pending}
                  />
                  <Button
                    label={t("Add tag")}
                    disabled={disabled || draft.trim().length === 0}
                    onPress={() => void changeTag(draft, true)}
                  />
                </View>
              </>
            )}
            {error === null ? null : <AppText accessibilityLiveRegion="polite">{error}</AppText>}
          </View>
        }
        renderItem={({ item: { tag, checked } }) => (
          <RowPressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked, disabled }}
            className="min-h-12 flex-row items-center justify-between gap-2 rounded-xl px-4"
            disabled={disabled}
            onPress={() => void changeTag(tag, false)}
          >
            <AppText className="min-w-0 flex-1">{tag}</AppText>
            {checked ? (
              <SymbolView name="checkmark" size={18} tintColorClassName="accent-foreground" />
            ) : null}
          </RowPressable>
        )}
      />
    </Sheet>
  );
}
