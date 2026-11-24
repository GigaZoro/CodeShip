import {
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildThreadMarkdown, threadMarkdownFileName } from "./threadMarkdown.ts";
import { guestMessage, legacyScheduledMessage } from "./userMessageTestFixtures.ts";

const now = DateTime.makeUnsafe("2026-11-20T09:30:00.000Z");

let counter = 0;
function base(status: OrchestrationV2TurnItem["status"] = "completed") {
  counter += 1;
  return {
    id: TurnItemId.make(`item-${counter}`),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: counter,
    status,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

const fileAttachment = (name: string) => ({
  type: "file" as const,
  id: `attachment-${name}`,
  name,
  mimeType: "text/plain",
  sizeBytes: 1,
});

const user = (text: string, attachments: ReadonlyArray<string> = []) =>
  ({
    ...base(),
    type: "user_message",
    messageId: MessageId.make(`message-${counter}`),
    inputIntent: "turn_start",
    text,
    createdBy: "user",
    creationSource: "web",
    attachments: attachments.map(fileAttachment),
  }) satisfies OrchestrationV2TurnItem;

const assistant = (text: string, attachments: ReadonlyArray<string> = []) =>
  ({
    ...base(),
    type: "assistant_message",
    messageId: MessageId.make(`message-${counter}`),
    text,
    attachments: attachments.map(fileAttachment),
    streaming: false,
  }) satisfies OrchestrationV2TurnItem;

const command = (input: string, status: OrchestrationV2TurnItem["status"] = "completed") =>
  ({ ...base(status), type: "command_execution", input }) satisfies OrchestrationV2TurnItem;

const rows = (...items: ReadonlyArray<OrchestrationV2TurnItem>) => items.map((item) => ({ item }));

const build = (items: ReadonlyArray<OrchestrationV2TurnItem>, title = "Fix login") =>
  buildThreadMarkdown({
    title,
    projectName: "Acme",
    createdAt: DateTime.formatIso(now),
    items: rows(...items),
  });

describe("buildThreadMarkdown", () => {
  it("writes the title, metadata and each message under its role, with the authored line breaks", async () => {
    const markdown = await build([
      user("Why is login\nslow?"),
      assistant("The query is\nunbounded."),
      assistant("★ Insight ─────\nOne\nTwo"),
    ]);

    expect(markdown).toBe(
      [
        "# Fix login",
        "Project: Acme · Created: 2026-11-20",
        "## User",
        "Why is login\nslow?",
        "## Assistant",
        "The query is\nunbounded.",
        "★ Insight ─────\nOne\nTwo",
      ].join("\n\n") + "\n",
    );
  });

  it("lists tools between messages as one bullet each and leaves out reasoning and notices", async () => {
    const markdown = await build([
      {
        ...user("/compact"),
        createdBy: "agent",
        creationSource: "server",
        idleCompaction: "onReturn",
      },
      user("Run it"),
      command("Preparing workspace"),
      command("pnpm test"),
      { ...base(), type: "file_change", fileName: "src/a.ts" },
      { ...base(), type: "reasoning", text: "thinking out loud", streaming: false },
      { ...base(), type: "system_notice", message: "Run started" },
      assistant("Done."),
    ]);

    expect(markdown).toContain(
      "## User\n\nRun it\n\n## Assistant\n\n- Ran `pnpm test`\n- Edited `src/a.ts`\n\nDone.\n",
    );
    expect(markdown).not.toContain("thinking out loud");
    expect(markdown).not.toContain("Run started");
    expect(markdown).not.toContain("Preparing workspace");
    expect(markdown).not.toContain("/compact");
  });

  it("retains deferred work and a compact prompt with an attachment", async () => {
    const markdown = await build([
      user("/compact", ["instructions.txt"]),
      {
        ...command("Preparing workspace"),
        deferredWork: { cursor: "work-page", itemCount: 100, lastOrdinal: 107 },
      },
    ]);

    expect(markdown).toContain("## User\n\n/compact");
    expect(markdown).toContain("- Ran `Preparing workspace`");
  });

  it("marks a failed command and shows only the first line of a script", async () => {
    const markdown = await build([
      command("set -e\nrm -rf build", "failed"),
      { ...command("pnpm lint"), exitCode: 2 },
      {
        ...command("pnpm build"),
        exitCode: 0,
        outputIndicatesFailure: true,
        output: "command not found",
      },
      { ...command("pnpm vet"), outputIndicatesFailure: true },
      { ...command("pnpm format"), output: "sh: pnpm: command not found" },
    ]);

    expect(markdown).toContain(
      "- Ran `set -e` (failed)\n- Ran `pnpm lint` (failed)\n- Ran `pnpm build`\n- Ran `pnpm vet` (failed)\n- Ran `pnpm format` (failed)\n",
    );
    expect(markdown).not.toContain("rm -rf");
  });

  it("names every file an edit changed, with the old path of a rename", async () => {
    const markdown = await build([
      {
        ...base(),
        type: "file_change",
        fileName: "src/a.ts",
        changes: [
          { operation: "update", path: "src/a.ts" },
          { operation: "rename", path: "src/c.ts", oldPath: "src/b.ts" },
        ],
      },
    ]);

    expect(markdown).toContain("- Edited `src/a.ts`, `src/b.ts` → `src/c.ts`\n");
  });

  it("keeps one Assistant heading across the tool lines of a turn", async () => {
    const markdown = await build([assistant("First."), command("ls"), assistant("Second.")]);

    expect(markdown.match(/## Assistant/gu)).toHaveLength(1);
  });

  it("keeps a fenced block in a message exactly as written, including a longer fence around a shorter one", async () => {
    const text = "Use this:\n\n````md\n```ts\nconst a = 1;\n```\n````\n\nThen run it.";

    expect(await build([assistant(text)])).toContain(`## Assistant\n\n${text}\n`);
  });

  it("ends the file without changing a message whose open fence runs to its end", async () => {
    const text = "- ~~~\n  hi\n";
    interface TreeNode {
      readonly type: string;
      readonly value?: string;
      readonly children?: ReadonlyArray<TreeNode>;
    }
    const codeValues = (markdown: string) => {
      const values: Array<string | undefined> = [];
      const pending: TreeNode[] = [parseMarkdownWithMath(markdown)];
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        if (node.type === "code") values.push(node.value);
        pending.push(...(node.children ?? []));
      }
      return values;
    };

    expect(codeValues(await build([assistant(text)]))).toEqual(codeValues(text));
  });

  it.each([
    ["quote", `${">".repeat(2000)}x`],
    ["list", `${"- ".repeat(2000)}x`],
  ])("shows a %s nested too deep to read as its source", async (_name, text) => {
    expect(await build([assistant(text)])).toContain(
      `## Assistant\n\n\`\`\`markdown\n${text}\n\`\`\``,
    );
  });

  it("keeps a message's list and the tool lines after it apart", async () => {
    const markdown = await build([assistant("- one\n- two"), command("ls"), user("Next")]);

    expect(parseMarkdownWithMath(markdown).children.map(({ type }) => type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "html",
      "list",
      "heading",
      "paragraph",
    ]);
  });

  it("resolves references within their message and scopes footnote labels in document order", async () => {
    const markdown = await build([
      assistant("> [x]: /first\n\n[x]: /second\n\n[read][x] and a note[^n]\n\n[^n]: First."),
      assistant("[x] and literal [^REF1]"),
      assistant("[next][x] and another[^n]\n\n[x]: /third\n\n[^n]: Second."),
    ]);

    expect(markdown).toContain(
      ">\n\n[read](/first) and a note[^ref21]\n\n[^ref21]: First.\n\n[x] and literal [^REF1]\n\n[next](/third) and another[^ref22]\n\n[^ref22]: Second.",
    );
  });

  it("widens a code span around a command that contains backticks", async () => {
    const markdown = await build([command("echo `date`")]);

    expect(markdown).toContain("- Ran `` echo `date` ``");
  });

  it("keeps a search without a query and marks a T3 tool whose result is an error", async () => {
    const markdown = await build([
      { ...base(), type: "file_search" },
      { ...base(), type: "web_search", patterns: [" "] },
      {
        ...base(),
        type: "dynamic_tool",
        toolName: "mcp__t3-code__html_render",
        input: {},
        output: { isError: true },
      },
      {
        ...base(),
        type: "dynamic_tool",
        toolName: "other_tool",
        input: {},
        output: { isError: true },
      },
    ]);

    expect(markdown).toContain(
      "- Searched files\n- Searched the web\n- Used tool `mcp__t3-code__html_render` (failed)\n- Used tool `other_tool`\n",
    );
  });

  it("writes the title and project name as literal text", async () => {
    const title = "Fix *login* <div> [x]";
    const markdown = await buildThreadMarkdown({
      title,
      projectName: "a_b `c`",
      createdAt: null,
      items: rows(user("Next")),
    });

    const [heading, metadata] = parseMarkdownWithMath(markdown).children;
    expect(heading).toMatchObject({ type: "heading", children: [{ type: "text", value: title }] });
    expect(metadata).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "Project: a_b `c`" }],
    });
  });

  it("gives way to the interface while it builds, and stops when the export is cancelled", async () => {
    let clock = 0;
    using _now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 20));
    const controller = new AbortController();
    const pending = buildThreadMarkdown(
      { title: "Long", projectName: null, createdAt: null, items: rows(user("a"), user("b")) },
      { signal: controller.signal },
    );
    queueMicrotask(() => setImmediate(() => controller.abort()));

    await expect(pending).rejects.toThrow("The thread export was cancelled.");
    await expect(
      buildThreadMarkdown(
        { title: "Long", projectName: null, createdAt: null, items: [] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("The thread export was cancelled.");
  });

  it("skips a workflow script, queued input not yet sent, and empty messages", async () => {
    const script = { ...user("run_workflow()"), workflowScript: true } as OrchestrationV2TurnItem;
    const queued = {
      ...user("Later"),
      inputIntent: "queued_turn",
      status: "pending",
    } as OrchestrationV2TurnItem;

    expect(await build([script, queued, assistant("   ")])).toBe(
      "# Fix login\n\nProject: Acme · Created: 2026-11-20\n",
    );
  });

  it("hides a legacy workflow opening while preserving ordinary JavaScript", async () => {
    const script = '// probe\nexport const meta = { name: "probe-wf" };\nconst GROUPS = [];';
    const parentThreadId = ThreadId.make("parent");
    const thread = {
      id: ThreadId.make("child"),
      lineage: {
        relationshipToParent: "subagent",
        parentThreadId,
        rootThreadId: parentThreadId,
      },
      creationSource: "provider",
    } as const;
    const input = {
      title: "Probe",
      projectName: null,
      createdAt: null,
      thread,
      items: rows(user(script), user(`Please review:\n\n${script}`)),
    };

    const written = script;

    expect(await buildThreadMarkdown(input)).toBe(
      `# Probe\n\n## User\n\nPlease review:\n\n${written}\n`,
    );
    expect(
      await buildThreadMarkdown({ ...input, thread: { ...thread, creationSource: "mcp" } }),
    ).toContain(`## User\n\n${written}`);
  });

  it("names attachments after the message that carries them, and keeps a message of attachments alone", async () => {
    const markdown = await build([
      user("See this", ["notes.txt"]),
      user(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, ["shot.png"]),
      assistant("", ["chart.svg"]),
    ]);

    expect(markdown).toContain(
      "## User\n\nSee this\n\nAttachments: `notes.txt`\n\nAttachments: `shot.png`\n\n## Assistant\n\nAttachments: `chart.svg`\n",
    );
    expect(markdown).not.toContain("without additional text");
  });

  it("exports the display text of guest messages and legacy scheduled prompts", async () => {
    const scheduled = legacyScheduledMessage("scheduled");
    const markdown = await build([
      { ...user(guestMessage.text), context: guestMessage.context },
      { ...user(scheduled.text), messageId: MessageId.make(scheduled.id) },
      user(scheduled.text),
    ]);

    expect(markdown).toContain("## User\n\nWhy?\n\nCheck for crashes.");
    expect(markdown).toContain(scheduled.text);
    expect(markdown).not.toContain("Message from guest Sam");
  });

  it("shows context references by their label, not the context they carry", async () => {
    const markdown = await build([
      user("Look at [Build log](t3-context://v1/terminal/build_1) now"),
      user("Fix it\n<terminal_context>\n- Build line 1:\n  secret output\n</terminal_context>"),
    ]);

    expect(markdown).toContain("Look at `Build log` now");
    expect(markdown).toContain("Fix it");
    expect(markdown).not.toContain("t3-context:");
    expect(markdown).not.toContain("terminal_context");
    expect(markdown).not.toContain("secret output");
  });

  it("writes each question with its answer and leaves out the message that repeats the answer", async () => {
    const requestId = RuntimeRequestId.make("request-1");
    const markdown = await build([
      {
        ...base(),
        type: "user_input_request",
        requestId,
        questions: [
          { id: "scope", header: "Scope", question: "Which files?", options: [] },
          { id: "script", header: "Script", question: "Which script?", options: [] },
        ],
        questionAnswer: {
          requestId,
          answers: { scope: ["src", "test"], script: "~~~js\nrun();\n~~~" },
          attachmentsByQuestionId: { scope: [fileAttachment("list.txt")] },
        },
      },
      { ...user("src, test"), messageId: MessageId.make(`async-answer:${requestId}`) },
      assistant("Thanks."),
    ]);

    expect(markdown).toContain(
      "## Questions\n\nWhich files?\n\nAnswer:\n\nsrc, test\n\nAttachments: `list.txt`\n\nWhich script?\n\nAnswer:\n\n~~~js\nrun();\n~~~\n\n## Assistant\n\nThanks.\n",
    );
    expect(markdown).not.toContain("## User");
  });

  it("falls back to a placeholder title and omits missing metadata", async () => {
    const markdown = await buildThreadMarkdown({
      title: "  ",
      projectName: null,
      createdAt: null,
      items: [],
    });

    expect(markdown).toBe("# Untitled thread\n");
  });
});

describe("threadMarkdownFileName", () => {
  it("removes path separators and reserved characters", () => {
    expect(threadMarkdownFileName('Fix: a/b "login"?')).toBe("Fix a b login.md");
  });

  it.each([
    ["CON", "CON_.md"],
    ["nul.report", "nul_.report.md"],
    ["COM¹.report", "COM¹_.report.md"],
    ["COM¹ .report", "COM¹_ .report.md"],
    ["lpt³.report", "lpt³_.report.md"],
    ["Com1 notes", "Com1 notes.md"],
  ])("keeps a Windows reserved name from naming a device: %s", (title, fileName) => {
    expect(threadMarkdownFileName(title)).toBe(fileName);
  });

  it("keeps an emoji at the length limit whole", () => {
    expect(threadMarkdownFileName(`${"a".repeat(79)}😀`)).toBe(`${"a".repeat(79)}.md`);
  });

  it("falls back when nothing usable remains", () => {
    expect(threadMarkdownFileName(" ../ ")).toBe("thread.md");
  });
});
