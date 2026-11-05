import { LegendList } from "@legendapp/list/react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import { useCallback, useState } from "react";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RelativeTime } from "../../components/RelativeTime";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreenContent } from "../settings/components/SettingsScreen";
import { artifactKey, filterArtifacts, type EnvironmentArtifact } from "./artifactList";
import { useArtifacts } from "./useArtifacts";

function ArtifactRow(props: {
  readonly artifact: EnvironmentArtifact;
  readonly environmentLabel: string | null;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onPress: () => void;
}) {
  const { artifact } = props;
  const subtitle = [artifact.threadTitle, artifact.projectTitle, props.environmentLabel]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${artifact.title}`}
      onPress={props.onPress}
      className={`flex-row items-center gap-3 bg-grouped-card px-4 py-3 ${props.isLast ? "" : "border-b border-separator"}`}
      style={{
        borderTopLeftRadius: props.isFirst ? 20 : 0,
        borderTopRightRadius: props.isFirst ? 20 : 0,
        borderBottomLeftRadius: props.isLast ? 20 : 0,
        borderBottomRightRadius: props.isLast ? 20 : 0,
        overflow: "hidden",
      }}
    >
      <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-subtle">
        <SymbolView
          name="square.on.square"
          size={15}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-base font-t3-bold leading-snug text-foreground"
            numberOfLines={1}
          >
            {artifact.title}
          </Text>
          <Text className="min-w-[30px] text-right text-xs tabular-nums text-foreground-tertiary">
            <RelativeTime timestamp={artifact.publishedAt} />
          </Text>
        </View>
        {subtitle ? (
          <Text className="text-2xs text-foreground-tertiary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function ArtifactsError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="mb-3 rounded-[20px] border border-danger-border bg-danger p-4">
      <Text className="text-base font-t3-bold text-danger-foreground">
        Could not load every environment's artifacts
      </Text>
      <Text className="mt-1 text-sm text-foreground-muted">{props.message}</Text>
      <View className="mt-3">
        <Button label="Try again" tone="secondary" onPress={props.onRetry} />
      </View>
    </View>
  );
}

export function ArtifactsScreen() {
  const navigation = useNavigation();
  const environmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { artifacts, error, isLoading, refresh } = useArtifacts(environmentIds);
  const [searchQuery, setSearchQuery] = useState("");
  // Agents publish while the app is open, so returning to the list reads it again.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const shown = filterArtifacts(artifacts, searchQuery);
  const isInitialLoad = isLoading && artifacts.length === 0 && error === null;
  const isFiltered = searchQuery.trim().length > 0;
  const multipleEnvironments = environmentIds.length > 1;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title="Artifacts"
        sidebar={false}
        onBack={() => navigation.goBack()}
        search={{
          value: searchQuery,
          onChangeText: setSearchQuery,
          placeholder: "Search artifacts",
          compactPlaceholder: "Search",
          mode: "inline",
        }}
        {...(Platform.OS === "android"
          ? {
              menus: [
                {
                  title: "Artifact options",
                  icon: "ellipsis.circle",
                  items: [{ id: "refresh", title: "Refresh artifacts", onPress: refresh }],
                },
              ],
            }
          : undefined)}
      />
      <SettingsScreenContent>
        <LegendList
          renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4 }}
          contentInsetAdjustmentBehavior="automatic"
          data={shown}
          estimatedItemSize={62}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={artifactKey}
          ListEmptyComponent={
            isInitialLoad ? (
              <View className="items-center py-16">
                <AppActivityIndicator colorClassName="accent-icon" />
                <Text className="mt-3 text-sm text-foreground-muted">Loading artifacts...</Text>
              </View>
            ) : error !== null ? null : (
              <EmptyState
                detail={
                  isFiltered
                    ? "Try another search."
                    : "Ask an agent for a chart, diagram, or mockup. Each page it publishes shows up here."
                }
                title={isFiltered ? "No matching artifacts" : "No artifacts yet"}
              />
            )
          }
          ListHeaderComponent={error ? <ArtifactsError message={error} onRetry={refresh} /> : null}
          refreshControl={
            <RefreshControl
              onRefresh={refresh}
              refreshing={isLoading && !isInitialLoad}
              tintColorClassName={String("accent-icon")}
            />
          }
          renderItem={({ item, index }) => (
            <ArtifactRow
              artifact={item}
              environmentLabel={
                multipleEnvironments
                  ? (savedConnectionsById[item.environmentId]?.environmentLabel ?? null)
                  : null
              }
              isFirst={index === 0}
              isLast={index === shown.length - 1}
              onPress={() =>
                navigation.navigate("Artifact", {
                  environmentId: item.environmentId,
                  attachmentId: item.attachmentId,
                })
              }
            />
          )}
          showsVerticalScrollIndicator={false}
        />
      </SettingsScreenContent>
    </View>
  );
}
