import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SplitButton } from "../../components/ui/SplitButton";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeUnavailableReason,
  mergeConflictReason,
  MERGE_METHODS,
  pullRequestActionLabel,
} from "./pullRequestActions";
import { pullRequestStackMerge, singlePullRequestMergeAllowed } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import type { PullRequestStackState } from "./usePullRequestStack";
import { t } from "../../lib/i18n";

export function PullRequestMergeControls(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const { pr, stack } = props;
  const terminology = sourceControlClients.get(pr.provider).changeRequest;
  const target = pullRequestTarget(props.params);
  const permissions = usePullRequestPermissions(props.params, pr);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const [selectedMethod, setSelectedMethod] = useState<PullRequestMergeMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const methods = allowedMergeMethods(pr);
  const preferred =
    selectedMethod ??
    (AsyncResult.isSuccess(preferences) ? preferences.value.pullRequestMergeMethod : undefined) ??
    "squash";
  const method = methods.includes(preferred)
    ? preferred
    : methods.includes("squash")
      ? "squash"
      : methods[0];
  const scope = stack.stack ? pullRequestStackMerge(stack.stack, pr.number, terminology) : null;
  const canMergeSingle = singlePullRequestMergeAllowed({
    supportsStackActions: stack.supportsStackActions,
    hasStack: stack.stack !== null,
    isFresh: stack.isFresh,
  });
  const checkingStack =
    permissions.connected && stack.supportsStackActions && !stack.isFresh && !stack.error;
  const reason =
    (!permissions.connected
      ? t("Reconnect to merge.")
      : mergeUnavailableReason(pr, permissions.canWrite, terminology)) ??
    (stack.stack
      ? !stack.supportsStackActions
        ? t("This environment can display stacks but cannot merge them.")
        : !stack.isFresh
          ? t("Refresh the stack before merging.")
          : scope?.reason
      : !canMergeSingle
        ? stack.error
          ? t("Couldn't check stack membership. Refresh before merging.")
          : t("Checking stack membership…")
        : null);
  const canMerge = !busy && method !== undefined && !reason;
  const label = method
    ? scope && scope.layers.length > 1
      ? t("{method} stack ({count})", {
          method: t(MERGE_METHODS[method].title),
          count: scope.layers.length,
        })
      : t(MERGE_METHODS[method].title)
    : t("Merge unavailable");
  const autoAction = pr.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge";
  const canAutoMerge =
    !busy &&
    (autoAction === "disable-auto-merge" || (!stack.stack && canMergeSingle)) &&
    permissions.canWrite &&
    canPerformPullRequestAction(pr, autoAction);

  const perform = async (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    if (
      pending.current ||
      (action !== "disable-auto-merge" && !method) ||
      (action === "merge" ? !canMerge : !canAutoMerge)
    )
      return;
    pending.current = true;
    setBusy(true);
    const response = await runAction({
      ...target,
      input: {
        ...target.input,
        action,
        ...(action === "merge" && method && stack.stack && scope
          ? {
              stackNumber: stack.stack.number,
              expectedStackHeads: scope.heads,
              mergeMethod: method,
            }
          : action === "merge" && method
            ? {
                resolveMergeMethod: (fresh) => {
                  if (
                    !canPerformPullRequestAction(fresh, "merge") ||
                    !allowedMergeMethods(fresh).includes(method)
                  )
                    throw new Error(
                      t("The {term} changed. Refresh before merging.", {
                        term: terminology.singular,
                      }),
                    );
                  return method;
                },
              }
            : action === "enable-auto-merge" && method
              ? { mergeMethod: method }
              : {}),
      },
    });
    // A stack can partly merge before the provider reports a failure.
    refreshDetail();
    refreshActivity();
    stack.refresh();
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        t("Couldn't complete the merge action"),
        cause instanceof Error ? cause.message : t("Try again."),
      );
    }
  };
  const confirm = (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    const methodName = String(method);
    const title =
      action === "merge"
        ? scope && scope.layers.length > 1
          ? t("Merge {count} stack layers?", { count: scope.layers.length })
          : t("{action}?", { action: pullRequestActionLabel("merge", terminology) })
        : action === "enable-auto-merge"
          ? t("Enable auto-merge?")
          : t("Disable auto-merge?");
    const message =
      action === "merge" && scope
        ? t("Merge {layers} into {base} using {method}. Layers above #{number} stay open.", {
            layers: scope.layers.map((layer) => `#${layer.number}`).join(" → "),
            base: stack.stack?.base ?? "",
            method: methodName,
            number: pr.number,
          })
        : action === "enable-auto-merge"
          ? t(
              "Merge #{number} using {method} when its requirements are met. This may happen immediately.",
              { number: pr.number, method: methodName },
            )
          : action === "disable-auto-merge"
            ? t("Stop the provider from automatically merging this {term}.", {
                term: terminology.singular,
              })
            : t("Merge #{number} into {base} using {method}.", {
                number: pr.number,
                base: pr.baseBranch,
                method: methodName,
              });
    Dialog.alert(title, message, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: action === "merge" ? label : title.replace("?", ""),
        onPress: () => void perform(action),
      },
    ]);
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <SplitButton
        label={busy ? t("Working…") : !permissions.connected ? t("Reconnect to merge") : label}
        accessibilityLabel={
          scope
            ? t("{label}, {count} stack layers through #{number}", {
                label,
                count: scope.layers.length,
                number: pr.number,
              })
            : label
        }
        icon={PullRequestGlyph.merged}
        disabled={!canMerge}
        loading={busy || checkingStack}
        onPress={() => confirm("merge")}
        menuTitle={t("Merge options")}
        actions={[
          ...methods.map((id) => ({
            id,
            title: t(MERGE_METHODS[id].title),
            state: id === method ? ("on" as const) : ("off" as const),
            attributes: { disabled: !canMerge && !canAutoMerge },
          })),
          ...(canAutoMerge
            ? [
                {
                  id: autoAction,
                  title: pr.autoMergeEnabled ? t("Disable auto-merge") : t("Enable auto-merge"),
                  image: "clock",
                },
              ]
            : []),
        ]}
        onPressAction={(id) => {
          const selected = methods.find((method) => method === id);
          if (selected) {
            setSelectedMethod(selected);
            savePreferences({ pullRequestMergeMethod: selected });
          } else if (id === autoAction && canAutoMerge) confirm(autoAction);
        }}
      />
      {permissions.connected &&
      reason &&
      reason !== mergeConflictReason() &&
      reason !== t("Checking stack membership…") &&
      !(checkingStack && reason === t("Refresh the stack before merging.")) ? (
        <Text className="px-1 text-xs text-foreground-muted">{reason}</Text>
      ) : null}
      {pr.autoMergeEnabled ? (
        <Text className="px-1 text-xs text-foreground-muted">
          {pr.autoMergeMethod
            ? t("Auto-merge is enabled · {method}", { method: pr.autoMergeMethod })
            : t("Auto-merge is enabled")}
        </Text>
      ) : null}
      {stack.error && stack.supportsStackActions ? (
        <Button label={t("Retry stack lookup")} tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
