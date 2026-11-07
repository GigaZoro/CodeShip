import {
  conversationImportNotice,
  conversationImportReport,
  importPolicyChanged,
} from "@t3tools/client-runtime/agent-conversation-import";

import * as Dialog from "../../components/ui/Dialog";
import { agentSessionSync } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SavedSettingsWrite } from "./useSettingsWriter";

// The import runs on the server after the setting saves, and its threads land settled, so say
// what it brought in and where; otherwise turning it on looks like it did nothing.
export function useReportConversationImport() {
  const sync = useAtomCommand(agentSessionSync, {
    label: "agent conversation import",
    reportFailure: false,
  });
  return async (saved: ReadonlyArray<SavedSettingsWrite>) => {
    const changed = saved.filter(importPolicyChanged);
    if (changed.length === 0) return;
    const reports = await Promise.all(
      changed.map(async (environment) =>
        conversationImportReport(
          environment,
          await sync({ environmentId: environment.environmentId, input: {} }),
        ),
      ),
    );
    const notice = conversationImportNotice(reports);
    Dialog.alert(notice.title, notice.description);
  };
}
