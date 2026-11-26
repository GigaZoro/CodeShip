import { t } from "../../lib/i18n";
import { LegendList } from "@legendapp/list/react-native";

import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { PullRequestSearchSheet } from "../pull-requests/PullRequestSearchSheet";

interface Candidate {
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly leading: ReactNode;
  readonly selected: boolean;
}

/** The searchable checklist behind the label and assignee pickers. */
export function IssueCandidatesSheet(props: {
  readonly title: string;
  readonly noun: "labels" | "people";
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly candidates: ReadonlyArray<Candidate>;
  readonly allowed: boolean;
  readonly notice: string | null;
  readonly pending: boolean;
  readonly loadError: string | null;
  readonly onRetry: () => void;
  readonly truncated: boolean;
  readonly onToggle: (key: string) => void;
}) {
  const labels = props.noun === "labels";
  const searching = props.query.trim().length > 0;
  return (
    <PullRequestSearchSheet
      title={props.title}
      placeholder={labels ? t("Search labels") : t("Search people")}
      closeAccessibilityLabel={t("Close {title}", { title: props.title.toLowerCase() })}
      clearAccessibilityLabel={t("Clear search")}
      query={props.query}
      onQueryChange={props.onQueryChange}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={props.candidates}
          keyExtractor={(candidate) => candidate.key}
          extraData={props.candidates}
          estimatedItemSize={64}
          recycleItems
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          ListHeaderComponent={
            props.notice ? (
              <View className="items-start gap-2 pb-3">
                <Text className="text-xs text-foreground-muted">{props.notice}</Text>
                {props.loadError && props.candidates.length > 0 ? (
                  <Button label={t("Retry")} size="compact" onPress={props.onRetry} />
                ) : null}
              </View>
            ) : undefined
          }
          renderItem={({ item, index }) => (
            <SelectionRow
              title={item.title}
              {...(item.subtitle ? { subtitle: item.subtitle } : {})}
              role="checkbox"
              selected={item.selected}
              disabled={!props.allowed}
              isFirst={index === 0}
              isLast={index === props.candidates.length - 1}
              leading={item.leading}
              onPress={() => props.onToggle(item.key)}
            />
          )}
          ListEmptyComponent={
            props.pending ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <View>
                <EmptyState
                  title={
                    props.loadError
                      ? labels
                        ? t("Couldn't load labels")
                        : t("Couldn't load people")
                      : searching
                        ? labels
                          ? t("No matching labels")
                          : t("No matching people")
                        : labels
                          ? t("This tracker has no labels")
                          : t("Nobody can be assigned here")
                  }
                  detail={
                    props.loadError ??
                    (searching
                      ? t("Try another name.")
                      : t("Add them on the tracker to use them here."))
                  }
                  variant="plain"
                />
                {props.loadError ? <Button label={t("Retry")} onPress={props.onRetry} /> : null}
              </View>
            )
          }
          ListFooterComponent={
            props.truncated ? (
              <Text className="py-4 text-xs text-foreground-muted">
                {labels
                  ? t("More labels exist than are listed here.")
                  : t("More people exist than are listed here.")}
              </Text>
            ) : undefined
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
