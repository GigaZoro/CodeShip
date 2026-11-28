import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  NEEDS_RUN_SKIP_EXIT_CODE,
  checkI18nParity,
  exitCodeForI18nGate,
} from "./i18n-diff-gate.mjs";

const SCRIPT_PATH = NodeURL.fileURLToPath(new URL("./i18n-diff-gate.mjs", import.meta.url));

function withTempWorkspace(fn) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-i18n-gate-test-"));
  try {
    return fn(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(root, relPath, content) {
  const full = NodePath.join(root, relPath);
  NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
  NodeFS.writeFileSync(full, content, "utf8");
}

describe("i18n-diff-gate", () => {
  it("exits 10 with needs_run=false when source messages and target TS catalog are in parity", () => {
    withTempWorkspace((dir) => {
      writeFile(
        dir,
        "apps/web/src/View.tsx",
        [
          'const title = t("Save settings");',
          'const items = tn(count, "{count} thread", "{count} threads");',
          'const label = cond ? t("Open") : t("Close");',
        ].join("\n"),
      );
      writeFile(
        dir,
        "packages/client-runtime/src/i18n/locales/uk.ts",
        [
          'import type { MessageCatalog } from "@t3tools/shared/i18n";',
          "const catalog: MessageCatalog = {",
          '  "Close": "Закрити",',
          '  "Open": "Відкрити",',
          '  "Save settings": "Зберегти налаштування",',
          '  "{count} threads": {',
          '    one: "{count} чат",',
          '    few: "{count} чати",',
          '    many: "{count} чатів",',
          '    other: "{count} чатів",',
          "  },",
          "};",
          "export default catalog;",
        ].join("\n"),
      );

      const cli = NodeChildProcess.spawnSync(
        process.execPath,
        [SCRIPT_PATH, "--needs-run", "--cwd", dir, "--source-dir", "apps/web/src"],
        { encoding: "utf8" },
      );
      expect(cli.status).toBe(NEEDS_RUN_SKIP_EXIT_CODE);
      const parsed = JSON.parse(cli.stdout.trim());
      expect(parsed).toMatchObject({
        ok: true,
        needs_run: false,
        source_keys: 4,
        missing_keys: 0,
        stale_keys: 0,
        broken_keys: 0,
      });
      expect(parsed.locales).toHaveLength(1);
      expect(parsed.locales[0]).toMatchObject({ locale: "uk", total_keys: 4 });
    });
  });

  it("exits 0 with needs_run=true and structured missing-key summary when keys are missing", () => {
    withTempWorkspace((dir) => {
      writeFile(
        dir,
        "apps/web/src/View.tsx",
        ['t("Save settings");', 't("Retry connection");'].join("\n"),
      );
      writeFile(
        dir,
        "packages/client-runtime/src/i18n/locales/uk.ts",
        [
          "const catalog = {",
          '  "Save settings": "Зберегти налаштування",',
          "};",
          "export default catalog;",
        ].join("\n"),
      );

      const cli = NodeChildProcess.spawnSync(
        process.execPath,
        [SCRIPT_PATH, "--needs-run", "--cwd", dir, "--source-dir", "apps/web/src"],
        { encoding: "utf8" },
      );
      expect(cli.status).toBe(0);
      const parsed = JSON.parse(cli.stdout.trim());
      expect(parsed).toMatchObject({
        ok: true,
        needs_run: true,
        source_keys: 2,
        missing_keys: 1,
        stale_keys: 0,
        broken_keys: 0,
      });
      expect(parsed.locales[0].missing).toEqual([
        { key: "Retry connection", file: "apps/web/src/View.tsx" },
      ]);
      expect(parsed.reason).toContain("1 missing");
    });
  });

  it("detects stale keys and broken placeholder/untranslated entries", () => {
    withTempWorkspace((dir) => {
      writeFile(
        dir,
        "apps/web/src/Panel.tsx",
        ['t("Hello {name}");', 't("Connection lost");'].join("\n"),
      );
      writeFile(
        dir,
        "packages/client-runtime/src/i18n/locales/uk.ts",
        [
          "const catalog = {",
          '  "Hello {name}": "Привіт {user}",',
          '  "Connection lost": "Connection lost",',
          '  "Removed label": "Видалена мітка",',
          "};",
          "export default catalog;",
        ].join("\n"),
      );

      const result = checkI18nParity({ cwd: dir, sourceDirs: ["apps/web/src"] });
      expect(result).toMatchObject({
        ok: true,
        needs_run: true,
        source_keys: 2,
        missing_keys: 0,
        stale_keys: 1,
        broken_keys: 2,
      });
      expect(result.locales[0].stale).toEqual(["Removed label"]);
      expect(result.locales[0].broken).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "Hello {name}" }),
          expect.objectContaining({ key: "Connection lost" }),
        ]),
      );
      expect(exitCodeForI18nGate(result, true)).toBe(0);
    });
  });

  it("compares an explicit source locale file against multiple target locales", () => {
    withTempWorkspace((dir) => {
      writeFile(dir, "locales/en.json", JSON.stringify({ greeting: "Hello", save: "Save" }));
      writeFile(dir, "locales/uk.json", JSON.stringify({ greeting: "Привіт", save: "Зберегти" }));
      writeFile(dir, "locales/de.json", JSON.stringify({ greeting: "Hallo" }));

      const result = checkI18nParity({
        cwd: dir,
        localesDir: "locales",
        sourceLocale: "locales/en.json",
      });
      expect(result).toMatchObject({
        ok: true,
        needs_run: true,
        source_keys: 2,
        missing_keys: 1,
        stale_keys: 0,
        broken_keys: 0,
      });
      expect(result.locales.map((entry) => [entry.locale, entry.missing_keys])).toEqual([
        ["de", 1],
        ["uk", 0],
      ]);
    });
  });
});
