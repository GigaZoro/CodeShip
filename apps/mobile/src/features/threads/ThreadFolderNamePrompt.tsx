import { MAX_THREAD_FOLDER_LENGTH } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import { KeyboardAvoidingView, Modal, Platform, TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";

export interface ThreadFolderNamePromptRequest {
  readonly title: string;
  readonly confirmText: string;
  readonly initialValue: string;
  readonly onConfirm: (name: string) => void;
}

interface PresentedPrompt extends ThreadFolderNamePromptRequest {
  readonly id: number;
}

// The system text prompts cannot cap the length or show a counter, so folder names use their
// own sheet. Like Dialog, the request lives in the module and the Host shows what is current.
let presented: PresentedPrompt | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

function setPresented(next: PresentedPrompt | null) {
  presented = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPresented() {
  return presented;
}

export function promptThreadFolderName(request: ThreadFolderNamePromptRequest): void {
  setPresented({ ...request, id: ++nextId });
}

export function ThreadFolderNamePromptHost() {
  const current = useSyncExternalStore(subscribe, getPresented, getPresented);
  return current ? <ThreadFolderNameSheet key={current.id} request={current} /> : null;
}

function ThreadFolderNameSheet(props: { readonly request: PresentedPrompt }) {
  const { request } = props;
  const [value, setValue] = useState(request.initialValue);
  const close = () => {
    if (presented?.id === request.id) setPresented(null);
  };
  const trimmed = value.trim();
  const submit = () => {
    if (trimmed.length === 0) return;
    close();
    request.onConfirm(trimmed);
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        className="flex-1 items-center justify-center bg-backdrop px-6"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View className="w-full max-w-md gap-4 rounded-3xl bg-screen p-6">
          <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
            {request.title}
          </AppText>
          <View className="gap-2">
            <View className="flex-row items-center justify-between gap-3">
              <AppText className="text-sm text-foreground-muted">{t("Folder name")}</AppText>
              <AppText className="text-sm text-foreground-muted">
                {`${value.length} / ${MAX_THREAD_FOLDER_LENGTH}`}
              </AppText>
            </View>
            <TextInput
              accessibilityLabel={t("Folder name")}
              autoFocus
              className="min-h-12 rounded-xl bg-subtle px-3 text-base text-foreground"
              maxLength={MAX_THREAD_FOLDER_LENGTH}
              onChangeText={setValue}
              onSubmitEditing={submit}
              returnKeyType="done"
              value={value}
            />
          </View>
          <View className="flex-row justify-end gap-3">
            <Button label={t("Cancel")} tone="text" onPress={close} />
            <Button
              label={request.confirmText}
              tone="secondary"
              disabled={trimmed.length === 0}
              onPress={submit}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
