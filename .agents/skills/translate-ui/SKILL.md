---
name: translate-ui
description: Fill T3.CodeShip's UI translation catalogs. Use when `node scripts/i18n-catalog.ts check` (CI's "Check UI translation catalogs" step, or `vp run check:changed`) reports missing, stale, or broken Ukrainian entries, after adding or changing UI text, or after an upstream sync.
---

# Translate UI text

T3.CodeShip's messages are their English source text. Catalogs map each message to its translation;
Ukrainian lives in `packages/client-runtime/src/i18n/locales/uk.ts`. How messages are written in
code is in [Interface translation](../../../docs/internals/i18n.md). Never edit the catalog by
hand: the script owns its shape and order.

## Steps

1. `node scripts/i18n-catalog.ts check`. Stale entries need nothing (merge drops them). For
   missing ones, continue.
2. `node scripts/i18n-catalog.ts missing <scratch>/missing.json`, using your scratchpad, never
   the repo. Each entry has `message`, `file` (where it shows), and for count-dependent text
   `plural: true` with the English singular in `one`.
3. Translate per the rules and [glossary](glossary.md) below. Write JSON objects that map the
   English message, byte for byte (straight apostrophes and all), to its translation. When you
   settle a term that will recur, add a row to the glossary. At most 150 entries per file
   (`<scratch>/uk-part01.json`, ...). Above ~800 messages, split the list and hand chunks to
   parallel subagents with this skill's path; they write only scratch files.
4. `node scripts/i18n-catalog.ts merge <scratch>/uk-part*.json`. It skips entries whose
   placeholders or plural forms are wrong and says why: fix those and merge again.
5. Repeat `check` until it passes, then `vp fmt packages/client-runtime/src/i18n/locales/uk.ts`.

## Rules

- Keep every `{placeholder}` exactly (names and braces); move it freely. Values are inserted as
  is, usually in the nominative case, so phrase around them: "Не вдалося скопіювати: {target}".
- Plural entries are objects with all four Ukrainian forms:
  `{ "one": "{count} файл", "few": "{count} файли", "many": "{count} файлів", "other": "{count} файлу" }`
  (one: 1, 21…; few: 2–4, 22–24…; many: 0, 5–20…; other: fractions). `{count}` may be left out
  of a form only where Ukrainian reads better without it.
- Keep in English: brand and product names, code, commands, file names, paths, URLs, env vars,
  key names, and model names (full list in the glossary). A translation identical to its English
  message passes the check only when every word in it is on the glossary's keep list.
- No em dashes (U+2014); a lint rule rejects them. Use a comma, a colon, or a spaced en dash.
- Polite plural "ви", lowercase. Buttons and menu items are short verbs ("Скасувати", "Зберегти").
- Match the source's casing: a message that starts lowercase is a fragment spliced into a
  sentence. Keep the trailing punctuation, the single "…" character, the typographic ’, and
  «…» for quoted text. Modern orthography ("проєкт").
- Be concise; UI space is tight. Open the `file` when the meaning is unclear (verb or state?
  files or threads?).
