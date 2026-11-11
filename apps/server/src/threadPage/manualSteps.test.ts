import { describe, expect, it } from "vite-plus/test";

import { limitNotes, selectNotesToRead } from "./manualSteps.ts";

const summary = (id: string, created_at: string, trashed = false) => ({ id, created_at, trashed });
const note = (createdAt: string, length: number) => ({
  createdAt,
  markdown: "x".repeat(length),
});

describe("selectNotesToRead", () => {
  it.each([
    ["no notes", [], []],
    [
      "a thread with few notes reads all of them, oldest first",
      [summary("b", "2026-11-02"), summary("a", "2026-11-01")],
      ["a", "b"],
    ],
    [
      "the work order and the newest three, skipping trashed notes",
      [
        summary("n1", "2026-11-01"),
        summary("n2", "2026-11-02"),
        summary("n3", "2026-11-03"),
        summary("n4", "2026-11-04"),
        summary("n5", "2026-11-05"),
        summary("gone", "2026-11-06", true),
      ],
      ["n1", "n3", "n4", "n5"],
    ],
  ])("%s", (_name, notes, expected) => {
    expect(selectNotesToRead(notes)).toEqual(expected);
  });
});

describe("limitNotes", () => {
  it("caps each note at 8,000 characters", () => {
    const [limited] = limitNotes([note("2026-11-01", 9_000)]);
    expect(limited?.markdown.length).toBe(8_000);
  });

  it("keeps the work order and the newest, and drops the oldest middle notes over 24,000", () => {
    const limited = limitNotes([
      note("2026-11-01", 8_000),
      note("2026-11-02", 8_000),
      note("2026-11-03", 8_000),
      note("2026-11-04", 8_000),
    ]);
    expect(limited.map((entry) => entry.createdAt)).toEqual([
      "2026-11-01",
      "2026-11-03",
      "2026-11-04",
    ]);
  });
});
