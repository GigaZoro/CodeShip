import { expect, it } from "@effect/vitest";
import {
  type AgentTerminalAccess,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as TerminalHandlers from "./handlers.ts";
import { TerminalToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:terminal");

const HISTORY =
  "\x1b[32mready\x1b[0m in 80ms\r\nbuilding 50%\rbuilding 100%\r\nError: \x1b[31mboom\x1b[0m\r\n$ ";

/** One running terminal. Typed input echoes, then `reply` prints. */
const fakeTerminal = (
  reply = "",
  initial = HISTORY,
  userInput: TerminalManager.TerminalThreadRead["userInput"] = null,
  /** What the OS reports while output pauses; null when it cannot tell. */
  commandRunning: boolean | null = null,
) => {
  let history = initial;
  const writes: Array<string> = [];
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const read = (): TerminalManager.TerminalThreadRead => ({
    threadId,
    terminalId: "term-1",
    cwd: "/home/user/app",
    worktreePath: null,
    status: "running",
    pid: 42,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "vite",
    updatedAt: "2026-01-01T00:00:00.000Z",
    history,
    cursor: `epoch.0.${history.length}`,
    cols: 100,
    userInput,
  });
  const service = {
    commandRunning: () => Effect.succeed(commandRunning),
    readThread: (id: string) => Effect.sync(() => (id === threadId ? [read()] : [])),
    subscribe: (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      }),
    write: (input: { readonly data: string }) =>
      Effect.gen(function* () {
        writes.push(input.data);
        const data = input.data.replace(/\r$/, "\r\n") + reply;
        history += data;
        for (const listener of listeners) {
          yield* listener({ type: "output", threadId, terminalId: "term-1", data });
        }
      }),
  };
  return { service, writes };
};

const callTool = (
  call: { readonly tool: "terminal_read" | "terminal_write"; readonly params: object },
  world: {
    /** Set as the project's own override, so project resolution is part of the check. */
    readonly access: AgentTerminalAccess;
    readonly runtimeMode?: RuntimeMode;
    readonly terminal?: ReturnType<typeof fakeTerminal>;
  },
) => {
  const terminal = world.terminal ?? fakeTerminal();
  return Effect.gen(function* () {
    const toolkit = yield* TerminalToolkit;
    const result = yield* toolkit
      .handle(call.tool, call.params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return { result: result.at(-1)?.result, writes: terminal.writes };
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(TerminalHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:terminal"),
              requestNamespace: "provider:terminal",
              thread: {
                threadId,
                providerSessionId: "provider:terminal",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed(
                  liveThreadShell(threadId, { runtimeMode: world.runtimeMode ?? "full-access" }),
                ),
            }),
            Layer.mock(Settings.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                projectSettingsOverrides: {
                  [ProjectId.make("project:mcp-test")]: { agentTerminalAccess: world.access },
                },
              }),
            }),
            Layer.mock(TerminalManager.TerminalManager)(terminal.service),
          ),
        ),
      ),
    ),
  );
};

it.effect.each([
  {
    name: "the last lines as the user sees them",
    params: { lines: 3 },
    output: "building 100%\nError: boom\n$",
    truncated: true,
  },
  {
    name: "only the output after a cursor",
    params: { after: `epoch.0.${HISTORY.indexOf("Error")}` },
    output: "Error: boom\n$",
    truncated: false,
  },
  {
    name: "everything for a cursor from another server run",
    params: { after: `other.0.${HISTORY.indexOf("Error")}` },
    output: "ready in 80ms\nbuilding 100%\nError: boom\n$",
    truncated: false,
  },
  {
    name: "a line the shell redrew relative to its prompt",
    // zsh returns to column 0 and skips the prompt's width to redraw what was typed.
    history: `${HISTORY}ls\r\x1b[2Cls -la\r\nREADME.md\r\n$ `,
    params: { after: `epoch.0.${HISTORY.length}` },
    output: "$ ls -la\nREADME.md\n$",
    truncated: false,
  },
])("reads $name", ({ history = HISTORY, params, output, truncated }) =>
  Effect.gen(function* () {
    const { result } = yield* callTool(
      { tool: "terminal_read", params },
      { access: "read", terminal: fakeTerminal("", history) },
    );
    expect(result).toEqual({
      terminals: [
        {
          terminalId: "term-1",
          label: "vite",
          cwd: "/home/user/app",
          status: "running",
          commandRunning: true,
          exitCode: null,
          output,
          truncated,
          cursor: `epoch.0.${history.length}`,
        },
      ],
    });
  }),
);

it.effect("types a command and returns its output once the prompt is back", () =>
  Effect.gen(function* () {
    const terminal = fakeTerminal("\x1b[?2004lsrc  package.json\r\n\x1b[?2004h$ ");
    const { result, writes } = yield* callTool(
      { tool: "terminal_write", params: { input: "ls" } },
      { access: "read-write", terminal },
    );
    expect(writes).toEqual(["ls\r"]);
    expect(result).toMatchObject({
      terminalId: "term-1",
      waitEnded: "command_finished",
      output: "$ ls\nsrc  package.json\n$",
    });
  }),
);

it.effect("returns once a shell that never announces its prompt runs no command", () =>
  Effect.gen(function* () {
    // bash 3.2 has no bracketed paste, so only the OS can tell the command is done.
    const terminal = fakeTerminal("hello\r\nbash-3.2$ ", HISTORY, null, false);
    const call = yield* callTool(
      { tool: "terminal_write", params: { input: "echo hello" } },
      { access: "read-write", terminal },
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("500 millis");
    const { result } = yield* Fiber.join(call);
    expect(result).toMatchObject({
      waitEnded: "command_finished",
      output: "$ echo hello\nhello\nbash-3.2$",
    });
  }),
);

it.effect("returns a long-running command's output once it pauses", () =>
  Effect.gen(function* () {
    const terminal = fakeTerminal("\x1b[?2004l  VITE ready in 412 ms\r\n", HISTORY, null, true);
    const call = yield* callTool(
      { tool: "terminal_write", params: { input: "pnpm dev" } },
      { access: "read-write", terminal },
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    const { result } = yield* Fiber.join(call);
    expect(result).toMatchObject({
      waitEnded: "output_quiet",
      output: "$ pnpm dev\n  VITE ready in 412 ms",
    });
  }),
);

it.effect.each([
  { name: "reading with no access", tool: "terminal_read" as const, access: "none" as const },
  { name: "typing with read access", tool: "terminal_write" as const, access: "read" as const },
  {
    name: "typing from a thread that needs approvals",
    tool: "terminal_write" as const,
    access: "read-write" as const,
    runtimeMode: "approval-required" as const,
  },
  {
    name: "typing while the user types there",
    tool: "terminal_write" as const,
    access: "read-write" as const,
    userInput: { at: 0, lineDirty: false },
  },
  {
    name: "typing over the user's unsent command",
    tool: "terminal_write" as const,
    access: "read-write" as const,
    userInput: { at: -60_000, lineDirty: true },
  },
])("refuses $name", ({ tool, access, runtimeMode, userInput = null }) =>
  Effect.gen(function* () {
    const { result, writes } = yield* callTool(
      { tool, params: tool === "terminal_write" ? { input: "rm -rf build" } : {} },
      {
        access,
        terminal: fakeTerminal("", HISTORY, userInput),
        ...(runtimeMode === undefined ? {} : { runtimeMode }),
      },
    );
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(writes).toEqual([]);
  }),
);
