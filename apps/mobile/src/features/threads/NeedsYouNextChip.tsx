import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { nextNeedsYouThread } from "@t3tools/client-runtime/state/thread-inbox";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { tn } from "../../lib/i18n";
import { environmentThreadShells } from "../../state/threads";

/** Opens the next thread that needs the user, as the web's "Next thread that needs you" does. */
export function NeedsYouNextChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const needsYou = useAtomValue(environmentThreadShells.needsYouThreadsAtom);
  const next = nextNeedsYouThread(needsYou.threads, {
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  if (next === null) return null;
  const others = needsYou.threads.filter(
    (thread) => thread.environmentId !== props.environmentId || thread.id !== props.threadId,
  ).length;
  const label = tn(others, "{count} more needs you", "{count} more need you");
  return (
    <View className="shrink-0 flex-row justify-end px-4 pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={next.title}
        hitSlop={8}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onOpen(next);
        }}
        className="min-h-9 flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 active:opacity-60"
      >
        <SymbolView name="bell.badge" size={13} tintColorClassName="accent-warning-foreground" />
        <Text className="text-xs font-t3-bold text-warning-foreground">{label}</Text>
        <SymbolView name="arrow.right" size={12} tintColorClassName="accent-warning-foreground" />
      </Pressable>
    </View>
  );
}
