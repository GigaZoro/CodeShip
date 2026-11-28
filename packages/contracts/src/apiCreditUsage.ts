import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderApiCredit } from "./provider.ts";

export const ApiCreditUsageRow = Schema.Struct({
  planInstanceId: ProviderInstanceId,
  planName: Schema.String,
  suggestedGrantUsd: Schema.NullOr(Schema.Number),
  apiAccounts: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      displayName: Schema.String,
      credit: ServerProviderApiCredit,
    }),
  ),
});
export type ApiCreditUsageRow = typeof ApiCreditUsageRow.Type;
