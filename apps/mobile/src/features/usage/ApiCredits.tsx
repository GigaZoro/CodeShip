import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SettingsSection } from "../settings/components/SettingsSection";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { getFormattingLocale, t } from "../../lib/i18n";

export function ApiCredits({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = serverEnvironment.apiCreditUsage({ environmentId, input: {} });
  const result = useAtomValue(query);
  const rows = AsyncResult.getOrElse(result, () => null);
  return (
    <SettingsSection title={t("Claude API credits")} footer={label}>
      <View className="gap-4 p-4">
        <Button
          label={t("Refresh credits")}
          tone="secondary"
          disabled={result.waiting}
          onPress={() => appAtomRegistry.refresh(query)}
        />
        {result._tag === "Failure" ? (
          <Text accessibilityRole="alert">{t("Could not load API credits. Try refreshing.")}</Text>
        ) : null}
        {result.waiting && rows === null ? (
          <AppActivityIndicator accessibilityLabel={t("Loading API credits")} />
        ) : null}
        {rows?.length === 0 ? (
          <Text>
            {t(
              "Add a Claude subscription account in Settings → Providers & models to track its API credits.",
            )}
          </Text>
        ) : null}
        {rows?.map((row) => (
          <View key={row.planInstanceId} className="gap-2">
            <Text className="font-t3-semibold" accessibilityRole="header">
              {row.planName}
            </Text>
            {row.apiAccounts.length === 0 ? (
              <>
                <Text>{t("Not linked")}</Text>
                <Text>
                  {t("Grant")}:{" "}
                  {row.suggestedGrantUsd === null ? t("Unknown") : formatUsd(row.suggestedGrantUsd)}
                </Text>
                <Text>
                  {t("Spend this cycle")}: {t("Unknown")}
                </Text>
                <Text>
                  {t("Estimated remaining")}: {t("Unknown")}
                </Text>
                <Text>
                  {t("Expires")}: {t("Unknown")}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {t(
                    "Open claude.ai → Settings → Billing → API credits and claim the grant for this plan.",
                  )}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {t(
                    "Link an Anthropic Console organization and turn off automatic reload in Console billing.",
                  )}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {t(
                    "Create an API key in that organization. In Settings → Providers & models, add a Claude account with Billing set to Pay per use, save the API key, and link this plan.",
                  )}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {t(
                    "Enter the grant amount and cycle end shown in Billing. Set Linked plan account to {instanceId}.",
                    { instanceId: row.planInstanceId },
                  )}
                </Text>
              </>
            ) : (
              row.apiAccounts.map(({ instanceId, displayName, credit }) => (
                <View key={instanceId} className="gap-1">
                  <Text>
                    {displayName} ·{" "}
                    {credit.balanceState === "exhausted" ? t("Spent") : t("Has balance")}
                  </Text>
                  <Text>
                    {t("Grant")}: {formatUsd(credit.grantUsd)}
                  </Text>
                  <Text>
                    {t("Spend this cycle")}:{" "}
                    {credit.spendUsd === null ? t("Unknown") : formatUsd(credit.spendUsd)}
                  </Text>
                  <Text>
                    {t("Estimated remaining")}:{" "}
                    {credit.estimatedRemainingUsd === null
                      ? t("Unknown")
                      : formatUsd(credit.estimatedRemainingUsd)}
                  </Text>
                  <Text>
                    {t("Expires")}:{" "}
                    {new Date(credit.cycleEnd).toLocaleString(getFormattingLocale())}
                  </Text>
                  {credit.reason ? <Text textRole="footnote">{credit.reason}</Text> : null}
                  {credit.unpricedUsage ? (
                    <Text textRole="footnote">
                      {t("Some usage could not be priced; remaining credit is unknown.")}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </View>
        ))}
        {rows?.some((row) => row.apiAccounts.length > 0) ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {t(
              "Spend is estimated from this environment’s recorded usage. Check Anthropic Console for the authoritative balance. CodeShip does not impose a spending cap; keep automatic reload off.",
            )}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
