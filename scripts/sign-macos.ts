import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

export default async function sign(options: SignOptions): Promise<void> {
  const selfSignIdentity = process.env.T3CODE_MACOS_SELF_SIGN_IDENTITY?.trim();
  const selfSignKeychain = process.env.T3CODE_MACOS_SELF_SIGN_KEYCHAIN?.trim();
  await signApplication({
    ...options,
    batchCodesignCalls: true,
    // osx-sign only looks up identities macOS trusts, and a self-signed certificate is not one.
    ...(selfSignIdentity ? { identity: selfSignIdentity, identityValidation: false } : {}),
    ...(selfSignIdentity && selfSignKeychain ? { keychain: selfSignKeychain } : {}),
  });
}
