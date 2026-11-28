import { useAtomValue } from "@effect/atom-react";
import type { ApiCreditUsageRow, EnvironmentId } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { getFormattingLocale, t } from "~/i18n";

export function ApiCredits({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = serverEnvironment.apiCreditUsage({ environmentId, input: {} });
  const result = useAtomValue(query);
  return (
    <ApiCreditRows
      label={label}
      rows={AsyncResult.getOrElse(result, () => null)}
      loading={result.waiting}
      error={result._tag === "Failure"}
      onRefresh={() => appAtomRegistry.refresh(query)}
    />
  );
}

export function ApiCreditRows({
  label,
  rows,
  loading,
  error,
  onRefresh,
}: {
  readonly label: string;
  readonly rows: ReadonlyArray<ApiCreditUsageRow> | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <section
      aria-label={t("Claude API credits on {environment}", { environment: label })}
      className="space-y-3 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {t("Claude API credits")} <span className="text-muted-foreground">· {label}</span>
        </h2>
        <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
          {t("Refresh credits")}
        </Button>
      </div>
      {error ? (
        <div role="alert" className="text-sm text-muted-foreground">
          {t("Could not load API credits. Try refreshing.")}
        </div>
      ) : null}
      {rows === null && loading ? (
        <div role="status" aria-label={t("Loading API credits")}>
          <p className="text-sm text-muted-foreground">{t("Loading API credits")}</p>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {rows?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "Add a Claude subscription account in Settings → Providers & models to track its API credits.",
          )}
        </p>
      ) : null}
      {rows?.map((row) => (
        <article key={row.planInstanceId} className="space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-medium break-words">{row.planName}</h3>
          {row.apiAccounts.length === 0 ? (
            <>
              <p className="text-sm font-medium">{t("Not linked")}</p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">{t("Grant")}</dt>
                  <dd>
                    {row.suggestedGrantUsd === null
                      ? t("Unknown")
                      : formatUsd(row.suggestedGrantUsd)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("Spend this cycle")}</dt>
                  <dd>{t("Unknown")}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("Estimated remaining")}</dt>
                  <dd>{t("Unknown")}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("Expires")}</dt>
                  <dd>{t("Unknown")}</dd>
                </div>
              </dl>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer py-1 text-foreground">
                  {t("Claim and link API credits")}
                </summary>
                <ol className="mt-2 list-decimal space-y-2 pl-5">
                  <li>
                    {t(
                      "Open claude.ai → Settings → Billing → API credits and claim the grant for this plan.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Link an Anthropic Console organization and turn off automatic reload in Console billing.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Create an API key in that organization. In Settings → Providers & models, add a Claude account with Billing set to Pay per use, save the API key, and link this plan.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Enter the grant amount and cycle end shown in Billing. Set Linked plan account to {instanceId}.",
                      { instanceId: row.planInstanceId },
                    )}
                  </li>
                </ol>
              </details>
            </>
          ) : (
            row.apiAccounts.map(({ instanceId, displayName, credit }) => (
              <div key={instanceId} className="space-y-2">
                <p className="text-sm break-words">
                  {displayName} ·{" "}
                  <strong>
                    {credit.balanceState === "exhausted" ? t("Spent") : t("Has balance")}
                  </strong>
                </p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">{t("Grant")}</dt>
                    <dd>{formatUsd(credit.grantUsd)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("Spend this cycle")}</dt>
                    <dd>{credit.spendUsd === null ? t("Unknown") : formatUsd(credit.spendUsd)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("Estimated remaining")}</dt>
                    <dd>
                      {credit.estimatedRemainingUsd === null
                        ? t("Unknown")
                        : formatUsd(credit.estimatedRemainingUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("Expires")}</dt>
                    <dd>
                      <time dateTime={credit.cycleEnd}>
                        {new Date(credit.cycleEnd).toLocaleString(getFormattingLocale())}
                      </time>
                    </dd>
                  </div>
                </dl>
                {credit.reason ? (
                  <p className="text-sm text-muted-foreground">{credit.reason}</p>
                ) : null}
                {credit.unpricedUsage ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Some usage could not be priced; remaining credit is unknown.")}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </article>
      ))}
      {rows?.some((row) => row.apiAccounts.length > 0) ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "Spend is estimated from this environment’s recorded usage. Check Anthropic Console for the authoritative balance. CodeShip does not impose a spending cap; keep automatic reload off.",
          )}
        </p>
      ) : null}
    </section>
  );
}
