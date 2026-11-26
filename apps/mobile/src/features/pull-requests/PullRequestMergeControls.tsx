import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SplitButton } from "../../components/ui/SplitButton";
import { useEnvironmentServerConfig } from "../../state/entities";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeUnavailableReason,
  MERGE_METHODS,
  PR_ACTION_ICONS,
  pullRequestActionLabel,
  resolveMergeMethod,
} from "./pullRequestActions";
import { pullRequestStackMerge, singlePullRequestMergeAllowed } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestAction } from "./usePullRequestAction";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
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
  const stateAction = usePullRequestAction(props.params, pr);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const serverSettings = useEnvironmentServerConfig(target.environmentId)?.settings;
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const [selectedMethod, setSelectedMethod] = useState<PullRequestMergeMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const methods = allowedMergeMethods(pr);
  const method = resolveMergeMethod(
    pr,
    selectedMethod,
    serverSettings
      ? resolveProjectSettings(serverSettings, target.input.projectId).settings
          .pullRequestMergeMethod
      : null,
    AsyncResult.isSuccess(preferences) ? preferences.value.pullRequestMergeMethod : undefined,
  );
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
  const nextAction =
    pr.state === "closed" ? "reopen" : pr.state === "open" && pr.isDraft ? "ready" : null;
  // States the button itself names, instead of a reason line under it. Draft and
  // closed offer their way forward when the viewer can take it.
  const status: {
    label: string;
    icon: AppSymbolName;
    final?: boolean;
    action?: "ready" | "reopen";
  } | null =
    nextAction && stateAction.available(nextAction)
      ? {
          label: pullRequestActionLabel(nextAction, terminology),
          icon: PR_ACTION_ICONS[nextAction],
          final: nextAction === "reopen",
          action: nextAction,
        }
      : pr.state === "merged"
        ? { label: t("Merged"), icon: PullRequestGlyph.merged, final: true }
        : pr.state === "closed"
          ? { label: t("Closed"), icon: PullRequestGlyph.closed, final: true }
          : pr.isDraft
            ? { label: t("Draft"), icon: PullRequestGlyph.draft }
            : pr.mergeability === "conflicting"
              ? { label: t("Resolve conflicts to merge"), icon: PullRequestGlyph.conflicting }
              : pr.autoMergeEnabled
                ? {
                    label: pr.autoMergeMethod
                      ? t("Auto-merge pending ({method})", { method: pr.autoMergeMethod })
                      : t("Auto-merge pending"),
                    icon: "clock",
                  }
                : checkingStack && !busy
                  ? { label: t("Checking stack…"), icon: PullRequestGlyph.merged }
                  : null;
  const autoAction = pr.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge";
  // A stack auto-merge request on this layer also covers the open layers below it.
  const stackAutoMerge =
    stack.stack !== null &&
    stack.supportsStackActions &&
    stack.isFresh &&
    pr.capabilities.stackAutoMerge === true;
  const canAutoMerge =
    !busy &&
    (autoAction === "disable-auto-merge" ||
      (stack.stack ? stackAutoMerge && scope !== null && !scope.reason : canMergeSingle)) &&
    permissions.canWrite &&
    canPerformPullRequestAction(pr, autoAction);

  const perform = async (
    action: "merge" | "enable-auto-merge" | "disable-auto-merge",
    shownHeadSha: string | undefined,
  ) => {
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
        // A merge lands the head on screen and refuses one that moved; a stack pins its other layers.
        ...(action !== "disable-auto-merge" && shownHeadSha
          ? { expectedHeadSha: shownHeadSha }
          : {}),
        // A cancel needs no pinned heads, so it keeps the stack scope even while the stack refreshes.
        ...(stack.stack &&
        ((action === "enable-auto-merge" && stackAutoMerge) ||
          (action === "disable-auto-merge" &&
            stack.supportsStackActions &&
            pr.capabilities.stackAutoMerge === true))
          ? { stackNumber: stack.stack.number }
          : {}),
        ...(action === "enable-auto-merge" && method && stackAutoMerge && scope
          ? { expectedStackHeads: scope.heads, mergeMethod: method }
          : action === "merge" && method && stack.stack && scope
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
    if (!AsyncResult.isSuccess(response)) refreshDetail();
    refreshActivity();
    stack.refresh();
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        t("Couldn't complete the merge action"),
        cause instanceof Error ? (errorDisplayMessage(cause) ?? cause.message) : t("Try again."),
      );
    }
  };
  const confirm = (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    const shownHeadSha = pr.headSha;
    const methodName = method ?? "";
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
        : action === "enable-auto-merge" && stackAutoMerge && scope
          ? t(
              "Merge {layers} into {base} using {method} once their requirements are met. This may happen immediately.",
              {
                layers: scope.layers.map((layer) => `#${layer.number}`).join(" → "),
                base: stack.stack?.base ?? "",
                method: methodName,
              },
            )
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
        text:
          action === "merge"
            ? label
            : action === "enable-auto-merge"
              ? t("Enable auto-merge")
              : t("Disable auto-merge"),
        onPress: () => void perform(action, shownHeadSha),
      },
    ]);
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <SplitButton
        label={
          busy || stateAction.busy
            ? t("Working…")
            : !permissions.connected
              ? t("Reconnect to merge")
              : (status?.label ?? label)
        }
        accessibilityLabel={
          status
            ? status.label
            : scope
              ? t("{label}, {count} stack layers through #{number}", {
                  label,
                  count: scope.layers.length,
                  number: pr.number,
                })
              : label
        }
        icon={status?.icon ?? PullRequestGlyph.merged}
        disabled={status?.action ? stateAction.busy : !canMerge || status !== null}
        loading={busy || stateAction.busy || (!status?.action && checkingStack)}
        onPress={() =>
          status?.action ? void stateAction.perform(status.action) : confirm("merge")
        }
        menuTitle={t("Merge options")}
        actions={
          status?.final
            ? []
            : [
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
                        title: pr.autoMergeEnabled
                          ? t("Disable auto-merge")
                          : t("Enable auto-merge"),
                        image: "clock",
                      },
                    ]
                  : []),
              ]
        }
        onPressAction={(id) => {
          const selected = methods.find((method) => method === id);
          if (selected) {
            setSelectedMethod(selected);
            void savePreferences({ pullRequestMergeMethod: selected });
          } else if (id === autoAction && canAutoMerge) confirm(autoAction);
        }}
      />
      {permissions.connected && !status && reason ? (
        <Text className="px-1 text-xs text-foreground-muted">{reason}</Text>
      ) : null}
      {stack.error && stack.supportsStackActions ? (
        <Button label={t("Retry stack lookup")} tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
