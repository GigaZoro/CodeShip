import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { GRANTED_TEXTS, parseClaudeDate, parseConfirmDialog } from "./claudeLimitResetText.ts";

describe("parseClaudeDate", () => {
  const now = DateTime.makeUnsafe("2026-11-15T12:00:00.000Z");
  it.each([
    { text: "Dec 1", at: "2026-12-01T00:00:00.000Z" },
    { text: "Dec 1, 2027", at: "2027-12-01T00:00:00.000Z" },
    { text: "Dec 1, 3pm", at: "2026-12-01T15:00:00.000Z" },
    { text: "Dec 1, 3:30pm", at: "2026-12-01T15:30:00.000Z" },
    { text: "Dec 1, 12am", at: "2026-12-01T00:00:00.000Z" },
    { text: "Dec 1, 12pm", at: "2026-12-01T12:00:00.000Z" },
    { text: "Jan 5, 2027, 9am", at: "2027-01-05T09:00:00.000Z" },
    { text: "Feb 30", at: undefined },
    { text: "Dec 1, 13pm", at: undefined },
    { text: "Dec 1, 3:75pm", at: undefined },
    { text: "Dez 1", at: undefined },
    { text: "next week", at: undefined },
  ])("reads $text as $at", ({ text, at }) => {
    expect(parseClaudeDate(text, now)).toBe(at);
  });
});

describe("parseConfirmDialog", () => {
  const now = DateTime.makeUnsafe("2026-11-15T12:00:00.000Z");
  const dialog = (detail: ReadonlyArray<string>) => [
    " Use a weekly reset?",
    " Refills your weekly limits now",
    ...detail,
    " ❯ Yes, use my weekly reset",
    "   No, keep it",
  ];
  it.each([
    {
      name: "a count and deadline",
      detail: [" 2 weekly resets left · use by Dec 1"],
      parsed: {
        kind: "weekly",
        resetsLeft: 2,
        expiresAt: "2026-12-01T00:00:00.000Z",
        yesSelected: true,
      },
    },
    {
      name: "a count without a deadline",
      detail: [" 2 weekly resets left"],
      parsed: { kind: "weekly", resetsLeft: 2, yesSelected: true },
    },
    { name: "no detail line", detail: [], parsed: undefined },
    {
      name: "an unread count",
      detail: [" a few weekly resets left · use by Dec 1"],
      parsed: undefined,
    },
    {
      name: "an unread deadline",
      detail: [" 2 weekly resets left · use by soon"],
      parsed: undefined,
    },
  ])("reads $name", ({ detail, parsed }) => {
    expect(parseConfirmDialog(dialog(detail), GRANTED_TEXTS, now)).toEqual(parsed);
  });
});
