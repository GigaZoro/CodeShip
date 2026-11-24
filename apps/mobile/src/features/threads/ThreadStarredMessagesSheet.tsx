import { useAtomValue } from "@effect/atom-react";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Sheet } from "../../components/ui/Sheet";
import { t } from "../../lib/i18n";
import { environmentThreadDetails } from "../../state/threads";
import { useThreadMessageStar } from "./ThreadMessageStars";

export function ThreadStarredMessagesSheet(props: {
  readonly thread: ScopedThreadRef;
  readonly onClose: () => void;
  readonly onSelect: (messageId: MessageId) => void;
}) {
  const insets = useSafeAreaInsets();
  const messages = useAtomValue(environmentThreadDetails.starredMessagePreviewsAtom(props.thread));
  return (
    <Sheet title={t("Starred messages")} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {messages.length === 0 ? (
          <Text className="text-sm text-foreground-secondary">{t("No starred messages")}</Text>
        ) : (
          messages.map(({ id, preview }, index) => (
            <StarredMessageRow
              key={id}
              thread={props.thread}
              messageId={id}
              label={preview || t("Starred message {number}", { number: index + 1 })}
              onSelect={props.onSelect}
            />
          ))
        )}
      </ScrollView>
    </Sheet>
  );
}

function StarredMessageRow(props: {
  readonly thread: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly label: string;
  readonly onSelect: (messageId: MessageId) => void;
}) {
  const star = useThreadMessageStar(props.thread, props.messageId);
  return (
    <View className="flex-row items-center">
      <Pressable
        accessibilityRole="button"
        className="min-h-11 flex-1 flex-row items-center gap-3 py-2"
        onPress={() => props.onSelect(props.messageId)}
      >
        <SymbolView name="star.fill" size={14} tintColorClassName="accent-warning-foreground" />
        <Text className="flex-1 text-sm text-foreground" numberOfLines={2}>
          {props.label}
        </Text>
      </Pressable>
      {star.allowed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Unstar {label}", { label: props.label })}
          accessibilityState={{ disabled: star.pending }}
          disabled={star.pending}
          className="size-11 items-center justify-center"
          onPress={() => star.setStarred(false)}
        >
          <SymbolView name="xmark" size={14} tintColorClassName="accent-foreground-secondary" />
        </Pressable>
      ) : null}
    </View>
  );
}
