import { describe, expect, it } from "vite-plus/test";

import {
  effectivePromptSource,
  promptFileDraft,
  promptFileDraftProblem,
  promptFileLostOnTarget,
  promptFileReadFor,
  promptUpsertFields,
} from "./scheduledTaskPromptFile.ts";

const lastRead = { at: "2026-11-12T08:00:00.000Z", ref: "origin/main", commit: "abcdef1234567" };
const fileTask = { promptFile: { path: "automations/daily.md", lastRead } } as never;

describe("promptFileDraft", () => {
  it.each([
    ["a text task", undefined, "text", "", null, null],
    ["a file task", fileTask, "file", "automations/daily.md", "automations/daily.md", lastRead],
    [
      "a shared copy not read yet",
      { promptFile: { path: "a.md", lastRead: null } } as never,
      "file",
      "a.md",
      "a.md",
      null,
    ],
  ] as const)("%s", (_name, task, promptSource, promptFile, savedPromptFile, promptLastRead) => {
    expect(promptFileDraft(task)).toEqual({
      promptSource,
      promptFile,
      savedPromptFile,
      promptLastRead,
    });
  });
});

describe("promptFileReadFor", () => {
  const draft = promptFileDraft(fileTask);
  it("shows the read for the saved path and not for an edited one", () => {
    expect(promptFileReadFor({ ...draft, promptFile: " automations/daily.md " })).toEqual(lastRead);
    expect(promptFileReadFor({ ...draft, promptFile: "automations/other.md" })).toBeNull();
  });
});

describe("promptFileDraftProblem", () => {
  it.each([
    ["a good path", "automations/daily.md", false, undefined],
    [
      "a webhook",
      "automations/daily.md",
      true,
      "A webhook task fills its prompt from each request.",
    ],
    ["an absolute path", "/etc/x.md", false, expect.stringContaining("absolute")],
    ["a Windows drive", "C:/x.md", false, expect.stringContaining("absolute")],
    ["a backslash", "a\\b.md", false, expect.stringContaining("forward slashes")],
    ["a control character", "a\tb.md", false, expect.stringContaining("control characters")],
    ["a parent part", "a/../b.md", false, expect.stringContaining("..")],
    ["an empty part", "a//b.md", false, expect.stringContaining("empty")],
    [
      "a too long path",
      `${"a/".repeat(300)}b.md`,
      false,
      "The prompt file path is longer than 512 characters.",
    ],
  ] as const)("%s", (_name, promptFile, isWebhook, problem) => {
    expect(promptFileDraftProblem({ promptFile, isWebhook })).toEqual(problem);
  });
});

describe("promptUpsertFields", () => {
  const base = { prompt: " text ", promptFile: " a.md " };
  it.each([
    ["older server, file draft", false, "file", { prompt: "text" }],
    ["file mode", true, "file", { promptFile: "a.md" }],
    ["text mode clears the file", true, "text", { prompt: "text", promptFile: null }],
  ] as const)("%s", (_name, supportsPromptFiles, promptSource, fields) => {
    expect(promptUpsertFields({ supportsPromptFiles, draft: { ...base, promptSource } })).toEqual(
      fields,
    );
  });

  it("treats a file draft as text on a server without prompt files", () => {
    expect(
      effectivePromptSource({ supportsPromptFiles: false, draft: { promptSource: "file" } }),
    ).toBe("text");
  });
});

describe("promptFileLostOnTarget", () => {
  it.each([
    ["a file draft on a server without prompt files", false, false, "file", true],
    ["a file draft on a server with prompt files", true, false, "file", false],
    ["a text draft on a server without prompt files", false, false, "text", false],
    ["a webhook, whose prompt comes from each request", false, true, "file", false],
  ] as const)("%s", (_name, supportsPromptFiles, isWebhook, promptSource, lost) => {
    expect(
      promptFileLostOnTarget({ supportsPromptFiles, isWebhook, draft: { promptSource } }),
    ).toBe(lost);
  });
});
