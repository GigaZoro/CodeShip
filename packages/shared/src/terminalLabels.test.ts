import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TERMINAL_ID, TerminalOpenInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { activateLanguage } from "./i18n.ts";
import { TEST_LANGUAGE } from "./testing/locale.ts";
import { getTerminalLabel, nextTerminalId } from "./terminalLabels.ts";
import { resolveTerminalSessionLabel } from "./terminalLabelsCopy.ts";

const decodeTerminalOpen = Schema.decodeUnknownSync(TerminalOpenInput);

describe("resolveTerminalSessionLabel", () => {
  it("translates idle defaults and agent ownership while keeping command names", () => {
    activateLanguage({
      language: "uk",
      catalog: { "Terminal {number}": "Термінал {number}", "{label} · agent": "{label} · агент" },
      formattingLocale: "uk",
    });
    try {
      const resolve = (label: string, hasRunningSubprocess: boolean, agentInput = false) =>
        resolveTerminalSessionLabel("term-2", { label, hasRunningSubprocess, agentInput });
      expect(getTerminalLabel("term-2")).toBe("Terminal 2");
      expect(resolve("Terminal 2", false)).toBe("Термінал 2");
      expect(resolve(" ", false)).toBe("Термінал 2");
      expect(resolve("sleep", true)).toBe("sleep");
      expect(resolve("Terminal 2", true)).toBe("Terminal 2");
      expect(resolve("sleep", true, true)).toBe("sleep · агент");
    } finally {
      activateLanguage(TEST_LANGUAGE);
    }
  });
});

describe("nextTerminalId", () => {
  it("skips over taken term-N slots", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-2", "term-3"])).toBe("term-4");
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-3"])).toBe("term-2");
    expect(nextTerminalId(["term-2", "term-3"])).toBe("term-1");
  });

  it("avoids unseen sessions when metadata is unavailable and resumes normal numbering", () => {
    const first = nextTerminalId([], "783c91cc-a413-47c7-8312-c2a5a1f05e40");
    const second = nextTerminalId([first], "102315fc-ceef-45c4-b978-c4d4947d3c26");
    expect(first).not.toBe(DEFAULT_TERMINAL_ID);
    expect(second).not.toBe(first);
    expect(getTerminalLabel(second)).toBe("Terminal 2");
    expect(nextTerminalId([first, second])).toBe("term-3");
    expect(
      decodeTerminalOpen({
        threadId: "thread",
        terminalId: second,
        cwd: "/workspace",
      }),
    ).toMatchObject({ terminalId: second });
  });
});
