import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { GitActionIconName } from "@t3tools/client-runtime/state/vcs";
import { SymbolView } from "../../../components/ui/AppSymbol";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { Button } from "../../../components/ui/Button";
import { t, tn } from "../../../lib/i18n";

export function SheetActionButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly onPress: () => void;
}) {
  return (
    <View className="flex-1">
      <Button {...props} fullWidth />
    </View>
  );
}

export function menuItemIconName(
  icon: GitActionIconName,
): ComponentProps<typeof SymbolView>["name"] {
  if (icon === "commit") return "checkmark.circle";
  if (icon === "push") return "arrow.up.circle";
  if (icon === "pull") return "arrow.down.circle";
  return "arrow.up.right.circle";
}

export function statusSummary(
  gitStatus: {
    readonly isRepo?: boolean;
    readonly hasWorkingTreeChanges?: boolean;
    readonly workingTree?: { readonly files: readonly { readonly path: string }[] };
    readonly aheadCount?: number;
    readonly behindCount?: number;
    readonly pr?: { readonly state?: string; readonly number?: number } | null;
    readonly sourceControlProvider?: { readonly kind: string } | null;
  } | null,
): string {
  if (!gitStatus) {
    return t("Loading branch status\u2026");
  }

  if (!gitStatus.isRepo) {
    return t("Not a git repository");
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    const fileCount = gitStatus.workingTree?.files.length ?? 0;
    parts.push(tn(fileCount, "{count} file changed", "{count} files changed"));
  } else {
    parts.push(t("Clean"));
  }
  if ((gitStatus.aheadCount ?? 0) > 0) {
    parts.push(t("{count} ahead", { count: gitStatus.aheadCount ?? 0 }));
  }
  if ((gitStatus.behindCount ?? 0) > 0) {
    parts.push(t("{count} behind", { count: gitStatus.behindCount ?? 0 }));
  }
  if (gitStatus.pr?.state === "open") {
    const { shortLabel } = sourceControlClients.get(
      gitStatus.sourceControlProvider?.kind,
    ).changeRequest;
    parts.push(
      t("{label} #{number} open", { label: shortLabel, number: gitStatus.pr.number ?? 0 }),
    );
  }

  return parts.join(" \u00b7 ");
}
