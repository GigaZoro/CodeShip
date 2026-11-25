import {
  SecretProviderId,
  SecretProviderKind,
  SecretProviderLabel,
  type SecretProviderConfig,
} from "@t3tools/contracts";
import {
  OnePasswordAccount,
  OnePasswordSecretProviderConfig,
} from "@t3tools/secret-provider-onepassword/shared/definition";
import { t } from "~/i18n";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeSecretProviderId = Schema.decodeOption(SecretProviderId);
const decodeOnePasswordConfig = Schema.decodeUnknownOption(OnePasswordSecretProviderConfig);

type ClassifiedOnePasswordProvider =
  | {
      readonly kind: "one_password";
      readonly auth: "desktop";
      readonly account: OnePasswordAccount;
    }
  | { readonly kind: "one_password"; readonly auth: "linux-service-account" };

export type SecretProviderAuth = ClassifiedOnePasswordProvider["auth"];

/** Unknown kinds and configs that no longer decode are shown read-only; removal stays available. */
export function classifySecretProvider(
  provider: SecretProviderConfig,
): ClassifiedOnePasswordProvider | { readonly kind: "unsupported" } {
  if (provider.kind !== "one_password") return { kind: "unsupported" };
  const decoded = decodeOnePasswordConfig(provider.config);
  if (Option.isNone(decoded)) return { kind: "unsupported" };
  return "account" in decoded.value
    ? { kind: "one_password", auth: "desktop", account: decoded.value.account }
    : { kind: "one_password", auth: decoded.value.auth };
}

/** Stable and readable in settings.json, so re-adding a provider under the same name restores its variables. */
function secretProviderIdFromName(name: string): SecretProviderId | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return Option.getOrNull(decodeSecretProviderId(slug));
}

export interface SecretProviderDraft {
  readonly name: string;
  readonly auth: SecretProviderAuth;
  readonly account: string;
}

export function draftFromSecretProvider(provider?: SecretProviderConfig): SecretProviderDraft {
  const classified = provider === undefined ? undefined : classifySecretProvider(provider);
  return {
    name: provider?.label ?? "",
    auth: classified?.kind === "one_password" ? classified.auth : "desktop",
    account:
      classified?.kind === "one_password" && classified.auth === "desktop"
        ? classified.account
        : "",
  };
}

export type SecretProviderTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: SecretProviderId };

export interface SecretProviderDraftIssues {
  readonly name?: string;
  readonly account?: string;
}

function decodeField<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
  emptyMessage: string,
): Result.Result<S["Type"], string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Result.fail(emptyMessage);
  return Result.mapError(Schema.decodeResult(schema)(trimmed), (error) => error.message);
}

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function secretProviderFromDraft(
  draft: SecretProviderDraft,
  existingIds: ReadonlySet<string>,
  target: SecretProviderTarget,
): Result.Result<
  { readonly id: SecretProviderId; readonly config: SecretProviderConfig },
  SecretProviderDraftIssues
> {
  const label = decodeField(SecretProviderLabel, draft.name, t("Enter a name."));
  const config: Result.Result<OnePasswordSecretProviderConfig, string> =
    draft.auth === "linux-service-account"
      ? Result.succeed({ auth: draft.auth })
      : Result.map(
          decodeField(OnePasswordAccount, draft.account, t("Enter the 1Password account.")),
          (account) => ({ account }),
        );

  let id: SecretProviderId | null = null;
  let nameIssue: string | undefined;
  if (Result.isFailure(label)) {
    nameIssue = label.failure;
  } else {
    id = target.mode === "edit" ? target.id : secretProviderIdFromName(label.success);
    if (id === null) nameIssue = t("The name needs at least one letter or digit.");
    else if (target.mode === "add" && existingIds.has(id))
      nameIssue = t("A secret provider with this name exists.");
  }

  if (
    id === null ||
    nameIssue !== undefined ||
    Result.isFailure(label) ||
    Result.isFailure(config)
  ) {
    return Result.fail({
      ...(nameIssue === undefined ? {} : { name: nameIssue }),
      ...(Result.isFailure(config) ? { account: config.failure } : {}),
    });
  }
  return Result.succeed({
    id,
    config: {
      kind: SecretProviderKind.make("one_password"),
      label: label.success,
      config: config.success,
    },
  });
}
