import { sign as signApplication } from "@electron/osx-sign";
import { expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

it("preserves upstream helper signatures and applies the CLI entitlements only inside the metadata package", async () => {
  const app = "Fixture.app";
  const root = "Fixture.app/Contents/Resources";
  const binary = (file: string) => `${root}/codex-metadata/${file}`;
  const inherited = { entitlements: "electron.plist", timestamp: "none", hardenedRuntime: false };
  await sign({ app, ignore: ["vendor/skip$"], optionsForFile: () => inherited });
  const [options] = vi.mocked(signApplication).mock.calls[0]!;
  const ignore = options.ignore;
  if (typeof ignore !== "function" || !options.optionsForFile)
    throw new Error("Missing file policy");
  expect(ignore(binary("bin/codex-code-mode-host"))).toBe(true);
  expect(ignore(binary("codex-path/rg"))).toBe(true);
  expect(ignore("vendor/skip")).toBe(true);
  expect(ignore(binary("bin/codex"))).toBe(false);
  expect(ignore(`${root}/other/rg`)).toBe(false);
  const context = { platform: "darwin" } as const;
  expect(options.optionsForFile(binary("bin/codex"), context)).toEqual({
    entitlements: [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ],
    hardenedRuntime: true,
    timestamp: "none",
  });
  expect(options.optionsForFile(`${root}/other/codex`, context)).toEqual(inherited);
});
