import type { ProviderAuthMethod } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export function providerAuthMethodText(
  driver: string,
  method: ProviderAuthMethod,
): ProviderAuthMethod {
  if (driver !== "claudeAgent") return method;
  if (method.id === "setup-token")
    return {
      ...method,
      name: t("One-year token"),
      description: t(
        "Stays signed in for a year with no renewals. Suits accounts that run scheduled tasks. Requires Pro, Max, Ultra, Team or Enterprise. Sessions on this account cannot use Remote Control or claude.ai connectors; MCP servers configured on this machine still work.",
      ),
    };
  if (method.id === "login")
    return {
      ...method,
      name:
        method.name === "Use regular sign-in instead"
          ? t("Use regular sign-in instead")
          : t("Claude account"),
      description: t("Signs in with `claude auth login`."),
    };
  return method;
}
