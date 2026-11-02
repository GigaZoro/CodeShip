import { describe, expect, it } from "vite-plus/test";

import { isThreadPageUrl } from "./threadPageLinks";

describe("isThreadPageUrl", () => {
  it.each([
    ["https://thread.page/app", true],
    ["https://thread.page/app/notes/0b7f6a62-5d3c-4f0e-9a51-6f2f1c8d4e21", true],
    ["https://THREAD.page/app/threads/abc?view=list#note-1", true],
    ["http://thread.page/app", false],
    ["https://thread.page.evil.example/app", false],
    ["https://evil.example/?next=https://thread.page/app", false],
    ["https://user@evil.example/thread.page", false],
    ["javascript:alert(1)//thread.page", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isThreadPageUrl(url)).toBe(expected);
  });
});
