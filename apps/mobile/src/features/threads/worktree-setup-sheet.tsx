import type { ReactElement } from "react";
import { Sheet } from "../../components/ui/Sheet";
import { t } from "../../lib/i18n";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose }: WorktreeSetupSheetProps) {
  return (
    <Sheet title={t("Worktree setup")} onClose={onClose}>
      {children}
    </Sheet>
  );
}
