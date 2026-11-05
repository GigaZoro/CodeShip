---
name: upstream-sync
description: Merge upstream T3 Code (pingdotgg/t3code) into T3.CodeShip and bring the result back to a translated, green state. Use when asked to sync with, pull from, or catch up with upstream t3code.
---

# Sync with upstream T3 Code

T3.CodeShip is a fork of `pingdotgg/t3code`. Upstream writes UI text in plain English, while every
T3.CodeShip client string goes through the translator (see
[Interface translation](../../../docs/internals/i18n.md)). A sync is done only when upstream's
new text is translatable and translated, as well as merged.

## 1. Merge

1. `git remote get-url upstream || git remote add upstream https://github.com/pingdotgg/t3code.git`,
   then `git fetch origin && git fetch upstream main`.
2. Branch from the latest `origin/main` (`sync/upstream-<date>`), never on `main` itself.
3. `git merge upstream/main`. Title the merge commit
   `chore: sync with upstream t3code (<upstream short sha>)`; the body gives the commit count and
   range and the conflict decisions.

## 2. Resolve conflicts

- Keep T3.CodeShip's naming and the fork's own features. New upstream text that names the product
  says T3.CodeShip.
- Where both sides built the same feature, upstream's version usually wins; record the call.
- Text conflicts are the common case: take upstream's English wording, written through the
  translator the way T3.CodeShip's side wrote it (`t("...")`, `tn(...)`, `msg("...")` in
  module-level tables, `tx(...)` for sentences with elements). Never resolve by dropping a `t()`
  wrapper to take upstream's raw string.
- Model-facing text (agent instructions, MCP tool descriptions, prompts) stays English; check
  `evals/README.md` when it changes.

## 3. Make new upstream text translatable

1. `vp lint apps/web/src apps/mobile/src apps/desktop/src` and fix every
   `t3code/no-untranslated-text` finding the way `docs/internals/i18n.md` describes. Text that
   isn't copy (stored data, text sent away, names) gets a suppression with its reason.
2. Typecheck the clients and shared packages. `not assignable to parameter of type 'Message'`
   means text reaches `t()` without the extractor seeing it: mark its source with `msg()`.
3. The lint rule doesn't see every string. Read upstream's diff of user-facing files
   (`git diff ORIG_HEAD..HEAD -- apps/*/src packages/client-runtime/src packages/shared/src`) for
   text in helpers, error builders, and option tables, and route it through the translator too.
4. For a large sync, split this step by directory across subagents with explicit file lists and
   this skill's path, then review their diffs.

## 4. Translate and verify

1. Follow the [translate-ui](../translate-ui/SKILL.md) skill until
   `node scripts/i18n-catalog.ts check` passes.
2. `vp run check:changed`, then run the tests of the packages the sync touched. Fix tests one
   side broke against the other side's code, as the earlier syncs did.
3. Spot-check the app in Ukrainian and in the development pseudo-language
   (Settings → General → Language → Pseudo, dev builds only): untranslated text shows up
   without the `⟦…⟧` brackets.
4. Land it the way the developer asks. Every push to `main` publishes a release.
