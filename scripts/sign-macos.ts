// @effect-diagnostics nodeBuiltinImport:off - This electron-builder hook also verifies the mounted release using macOS codesign.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import Plist from "plist";

// Pinned upstream codex and codex-code-mode-host entitlement plists.
const v8Entitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
];

function metadataBinaries(app: string) {
  const root = NodePath.posix.join(app, "Contents", "Resources", "codex-metadata");
  return {
    cli: NodePath.posix.join(root, "bin", "codex"),
    host: NodePath.posix.join(root, "bin", "codex-code-mode-host"),
    rg: NodePath.posix.join(root, "codex-path", "rg"),
  };
}

export default async function sign(options: SignOptions): Promise<void> {
  const selfSignIdentity = process.env.T3CODE_MACOS_SELF_SIGN_IDENTITY?.trim();
  const selfSignKeychain = process.env.T3CODE_MACOS_SELF_SIGN_KEYCHAIN?.trim();
  const { cli, host, rg } = metadataBinaries(options.app);
  const otherIgnores = [options.ignore ?? []].flat();
  await signApplication({
    ...options,
    batchCodesignCalls: true,
    // These unmodified npm helpers already have upstream Developer ID signatures.
    ignore: (file) =>
      file === host ||
      file === rg ||
      otherIgnores.some((rule) => (typeof rule === "function" ? rule(file) : file.match(rule))),
    optionsForFile: (file, context) => {
      const inherited = options.optionsForFile?.(file, context) ?? {};
      return file === cli
        ? { ...inherited, entitlements: [...v8Entitlements], hardenedRuntime: true }
        : inherited;
    },
    // osx-sign only looks up identities macOS trusts, and a self-signed certificate is not one.
    ...(selfSignIdentity ? { identity: selfSignIdentity, identityValidation: false } : {}),
    ...(selfSignIdentity && selfSignKeychain ? { keychain: selfSignKeychain } : {}),
  });
}

if (import.meta.main) {
  const [operation, app] = process.argv.slice(2);
  if (operation !== "--verify-codex-metadata" || !app) {
    throw new Error("Usage: node scripts/sign-macos.ts --verify-codex-metadata <app>");
  }
  const { cli, host, rg } = metadataBinaries(app);
  const expectedV8 = Object.fromEntries(v8Entitlements.map((key) => [key, true]));
  for (const binary of [cli, host, rg]) {
    const args = ["--verify", "--strict"];
    if (binary !== cli) {
      const id = binary === host ? "codex-code-mode-host" : "com.openai.codex.rg";
      args.push(
        "--test-requirement",
        `=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "${id}"`,
      );
    }
    NodeChildProcess.execFileSync("/usr/bin/codesign", [...args, binary], { stdio: "inherit" });
    const xml = NodeChildProcess.execFileSync(
      "/usr/bin/codesign",
      ["--display", "--entitlements", "-", "--xml", binary],
      {
        encoding: "utf8",
      },
    );
    const actual = xml ? Plist.parse(xml) : undefined;
    if (!NodeUtil.isDeepStrictEqual(actual, binary === rg ? undefined : expectedV8)) {
      throw new Error(`Unexpected signing entitlements on ${binary}`);
    }
  }
}
