import { SecretProviderKind } from "@t3tools/contracts/settings";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Schema from "effect/Schema";

const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Any value `op --account` accepts: shorthand, sign-in address, account ID, or user ID.
 * It is passed to the CLI as an argument, so it can never start with `-`.
 */
export const OnePasswordAccount = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.makeFilter((value: string) =>
    ACCOUNT_PATTERN.test(value)
      ? true
      : "1Password account must be a shorthand, sign-in address, or ID with no spaces.",
  ),
).pipe(Schema.brand("OnePasswordAccount"));
export type OnePasswordAccount = typeof OnePasswordAccount.Type;

const LinuxServiceAccountConfig = Schema.declare(
  (value): value is { readonly auth: "linux-service-account" } =>
    typeof value === "object" &&
    value !== null &&
    "auth" in value &&
    Object.hasOwn(value, "auth") &&
    value.auth === "linux-service-account" &&
    Reflect.ownKeys(value).length === 1,
);

export const OnePasswordSecretProviderConfig = Schema.Union([
  Schema.Struct({
    account: OnePasswordAccount,
    auth: Schema.optionalKey(Schema.Never),
  }),
  LinuxServiceAccountConfig,
]);
export type OnePasswordSecretProviderConfig = typeof OnePasswordSecretProviderConfig.Type;

// 1Password secret reference syntax: names outside this charset must be written as item ids.
// It also keeps `{{`, `}}`, and line breaks out of the `op inject` template the server builds.
const NAME = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`;
const REFERENCE = new RegExp(
  String.raw`^op://${NAME}(?:/${NAME}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`,
);
const MAX_REFERENCE_LENGTH = 1024;
const isOnePasswordReference = (reference: string) =>
  reference.length <= MAX_REFERENCE_LENGTH && REFERENCE.test(reference);

// sudoers matches the joined argument string, so a grant must contain a single literal reference.
export const isOnePasswordLinuxServiceAccountReference = (reference: string) =>
  isOnePasswordReference(reference) && !/[\s?]/.test(reference);

export const definition = defineSecretProvider({
  kind: SecretProviderKind.make("one_password"),
  label: "1Password",
  configSchema: OnePasswordSecretProviderConfig,
  isReference: isOnePasswordReference,
  referencePlaceholder: "op://vault/item/field",
  invalidReferenceMessage: "Use a 1Password reference like op://vault/item/field.",
});
