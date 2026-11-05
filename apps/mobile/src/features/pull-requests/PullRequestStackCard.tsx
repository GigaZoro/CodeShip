import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Platform, View } from "react-native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { pullRequestLayerParams } from "./pullRequestStack";
import { pullRequestStatus } from "./pullRequestStatus";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import { t } from "../../lib/i18n";

export function PullRequestStackCard(props: {
  readonly params: PullRequestParams;
  readonly state: PullRequestStackState;
}) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const [expanded, setExpanded] = useState(false);
  const stack = props.state.stack;
  if (!stack) {
    const summary =
      props.params.initialSummary?.number === props.params.number
        ? props.params.initialSummary.stack
        : undefined;
    if (!summary) return null;
    return (
      <PullRequestCardGroup>
        <PullRequestCardRow
          title={t("Stack")}
          icon={PullRequestGlyph.stack}
          value={t("{position} of {size}", { position: summary.position, size: summary.size })}
          last
        />
      </PullRequestCardGroup>
    );
  }
  const position = stack.layers.findIndex((layer) => layer.number === props.params.number) + 1;
  return (
    <PullRequestCardGroup>
      <PullRequestCardRow
        title={t("Stack")}
        icon={PullRequestGlyph.stack}
        value={t("{position} of {size}", { position, size: stack.layers.length })}
        accessibilityLabel={
          props.state.isFresh
            ? t("Stack, {position} of {size}", { position, size: stack.layers.length })
            : t("Stack, {position} of {size}, showing saved stack", {
                position,
                size: stack.layers.length,
              })
        }
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        last={!expanded}
      />
      {expanded ? (
        <View>
          {stack.layers.map((layer, index) => {
            const selected = layer.number === props.params.number;
            const status = pullRequestStatus({
              state: layer.state,
              isDraft: layer.isDraft === true,
            });
            return (
              <View key={layer.number} className={selected ? "bg-thread-selected" : undefined}>
                <PullRequestCardRow
                  title={layer.title ?? layer.headBranch}
                  icon={status.icon}
                  tint={status.tint}
                  value={selected ? t("Current") : status.label}
                  detail={t("#{number} · {position} of {size}", {
                    number: layer.number,
                    position: index + 1,
                    size: stack.layers.length,
                  })}
                  onPress={
                    selected
                      ? undefined
                      : () => {
                          const params = pullRequestLayerParams(props.params, layer.number);
                          if (Platform.OS === "android")
                            selectDetail({ name: "PullRequest", params });
                          else navigation.dispatch(StackActions.push("PullRequest", params));
                        }
                  }
                  last={index === stack.layers.length - 1}
                />
              </View>
            );
          })}
          <Text className="px-4 py-3 text-xs text-foreground-muted">
            {t("Base: {base}. Open a layer to review it or merge the stack through that layer.", {
              base: stack.base,
            })}
          </Text>
        </View>
      ) : null}
    </PullRequestCardGroup>
  );
}
