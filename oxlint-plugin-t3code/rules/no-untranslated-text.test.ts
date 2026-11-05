import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-untranslated-text", {
  filename: "fixture.tsx",
});

describe("t3code/no-untranslated-text", () => {
  rule.valid(
    "allows translated text, glyphs, and literal opt-outs",
    `const el = (
      <Row label={t("Word wrap")} className="truncate">
        {t("Settings")} · 42 {"GitHub"} ⌘
      </Row>
    );`,
  );

  rule.valid(
    "allows props that are not user-facing text",
    `const el = <Button variant="ghost" size="sm" data-testid="close-button" />;`,
  );

  rule.valid(
    "allows translated fields, identifiers, and names that read the same everywhere",
    `const options = [
      { value: "split", label: msg("Split"), title: t("Split view") },
      { value: "primary", label: "primary", description: someText },
      { label: "GitHub" },
    ];
    const save = useAtomCommand(saveCommand, { label: "Save settings" });
    const el = <span>CodeShip</span>;`,
  );

  rule.invalid(
    "reports copy in object fields such as toast titles",
    `toastManager.add({ type: "error", title: "Could not save" });`,
    (output) => {
      assert.match(output, /no-untranslated-text/);
    },
  );

  rule.invalid(
    "reports copy kept in a label variable",
    `const sidebarLabel = panel === "settings" ? t("Settings") : "Threads";`,
    (output) => {
      assert.match(output, /no-untranslated-text/);
    },
  );

  rule.invalid(
    "reports text passed to alerts and announcements",
    `Alert.alert(t("Delete thread?"), "This cannot be undone.");`,
    (output) => {
      assert.match(output, /no-untranslated-text/);
    },
  );

  rule.invalid("reports raw JSX text", `const el = <span>Archive thread</span>;`, (output) => {
    assert.match(output, /Translate UI text with t\(\)/);
  });

  rule.invalid(
    "reports raw text props",
    `const el = <button aria-label="Close dialog" />;`,
    (output) => {
      assert.match(output, /no-untranslated-text/);
    },
  );

  rule.invalid(
    "reports text built from a template",
    `const el = <span>{\`\${count} files\`}</span>;`,
    (output) => {
      assert.match(output, /no-untranslated-text/);
    },
  );

  rule.invalid(
    "reports raw strings in conditional branches",
    `const el = <Tip title={open ? "Collapse" : t("Expand")} />;`,
    (output) => {
      assert.match(output, /no-untranslated-text/);
    },
  );
});
