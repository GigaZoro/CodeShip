import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliInstallCommand,
  cliReleaseRepository,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("uses the build's repository for releases and falls back to upstream", () => {
    expect(cliReleaseRepository("GigaZoro/CodeShip")).toBe("GigaZoro/CodeShip");
    expect(cliReleaseRepository(" GigaZoro/CodeShip\n")).toBe("GigaZoro/CodeShip");
    for (const unusable of [undefined, "", "not-a-repository", "a/b; rm -rf ~"]) {
      expect(cliReleaseRepository(unusable)).toBe("pingdotgg/t3code");
    }
    expect(cliInstallCommand("1.2.3", "pingdotgg/t3code")).toBe(
      "curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=1.2.3 sh",
    );
    expect(cliInstallCommand("2026.1107.4", "GigaZoro/codeship-releases")).toBe(
      "curl -fsSL https://github.com/GigaZoro/codeship-releases/releases/download/v2026.1107.4/install.sh | T3CODE_RELEASE_REPOSITORY=GigaZoro/codeship-releases T3CODE_VERSION=2026.1107.4 sh",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
