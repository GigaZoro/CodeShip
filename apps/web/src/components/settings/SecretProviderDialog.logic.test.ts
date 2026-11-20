import { SecretProviderId, SecretProviderKind, SecretProviderLabel } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { draftFromSecretProvider, secretProviderFromDraft } from "./SecretProviderDialog.logic";

const personalId = SecretProviderId.make("personal");
const serviceAccountConfig = {
  kind: SecretProviderKind.make("one_password"),
  label: SecretProviderLabel.make("Personal"),
  config: { auth: "linux-service-account" },
};

describe("secretProviderFromDraft", () => {
  it("adds a provider keyed by its name and reports every field that blocks it", () => {
    expect(
      secretProviderFromDraft(
        { ...draftFromSecretProvider(), name: "  1Password!  ", account: "my.1password.com" },
        new Set(),
        { mode: "add" },
      ),
    ).toEqual(
      Result.succeed({
        id: "1password",
        config: {
          kind: "one_password",
          label: "1Password!",
          config: { account: "my.1password.com" },
        },
      }),
    );

    const blocked = secretProviderFromDraft(
      { ...draftFromSecretProvider(), name: "1Password", account: "--help" },
      new Set(["1password"]),
      { mode: "add" },
    );
    expect(Result.isFailure(blocked) && Object.keys(blocked.failure).toSorted()).toEqual([
      "account",
      "name",
    ]);
  });

  it("keeps the id when an edit renames the provider", () => {
    const result = secretProviderFromDraft(
      { name: "Personal (team)", auth: "desktop", account: "team.1password.com" },
      new Set(["personal"]),
      { mode: "edit", id: personalId },
    );
    expect(Result.isSuccess(result) && result.success).toEqual({
      id: personalId,
      config: {
        kind: "one_password",
        label: "Personal (team)",
        config: { account: "team.1password.com" },
      },
    });
  });

  it("adds a Linux service account without validating or saving the desktop account field", () => {
    const draft = { name: "Personal", auth: "linux-service-account", account: "--help" } as const;

    const result = secretProviderFromDraft(draft, new Set(), { mode: "add" });

    expect(result).toEqual(Result.succeed({ id: personalId, config: serviceAccountConfig }));
  });

  it("preserves the stored Linux service account when editing the provider", () => {
    const draft = draftFromSecretProvider(serviceAccountConfig);

    const result = secretProviderFromDraft(draft, new Set([personalId]), {
      mode: "edit",
      id: personalId,
    });

    expect(result).toEqual(Result.succeed({ id: personalId, config: serviceAccountConfig }));
  });

  it("converts a Linux service account to desktop integration under the same ID", () => {
    const draft = draftFromSecretProvider(serviceAccountConfig);

    const result = secretProviderFromDraft(
      { ...draft, auth: "desktop", account: "my.1password.com" },
      new Set([personalId]),
      { mode: "edit", id: personalId },
    );

    expect(result).toEqual(
      Result.succeed({
        id: personalId,
        config: { ...serviceAccountConfig, config: { account: "my.1password.com" } },
      }),
    );
  });
});
