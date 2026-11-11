import {
  detectedManualStepText,
  type DetectedManualStepEntry,
  type DetectedManualStepText,
} from "@t3tools/client-runtime/state/manualSteps";
import { useNavigate } from "@tanstack/react-router";

import { providerClients } from "../settings/providerDriverMeta";
import { getFormattingLocale } from "~/i18n";

const formatLoginDate = (iso: string) =>
  new Intl.DateTimeFormat(getFormattingLocale(), { dateStyle: "medium" }).format(new Date(iso));

export function detectedStepText({ step }: DetectedManualStepEntry): DetectedManualStepText {
  return detectedManualStepText(step, {
    driverLabel: providerClients.get(step.driver)?.label ?? step.driver,
    formatDate: formatLoginDate,
  });
}

/** Opens the fix on the step's machine: the account's card, or the MCP server's row. */
export function useOpenDetectedStep() {
  const navigate = useNavigate();
  return ({ environmentId, step }: DetectedManualStepEntry) => {
    if (step.kind === "mcp-needs-auth") {
      return navigate({
        to: "/extensions",
        search: {
          tab: "mcp",
          environmentId,
          ...(step.serverName ? { server: step.serverName } : {}),
        },
      });
    }
    return navigate({
      to: "/settings/providers",
      search: { environmentId, instanceId: step.instanceId },
    });
  };
}
