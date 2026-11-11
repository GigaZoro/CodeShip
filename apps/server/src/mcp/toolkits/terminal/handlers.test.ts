import { expect, it } from "@effect/vitest";
import {
  type AgentTerminalAccess,
  DEFAULT_SERVER_SETTINGS,
  type Project,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as TerminalHandlers from "./handlers.ts";
import { TerminalToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:terminal");

/** An agent on another machine, through that machine's link to this one. */
const link = (
  access: McpInvocationContext.McpClientCaller["access"],
  narrowedTo?: McpInvocationContext.ClientModes,
): McpInvocationContext.McpClientCaller => ({
  sessionId: "session:link",
  label: "Laptop",
  access,
  linked: true,
  ...(narrowedTo === undefined ? {} : { narrowedTo }),
});

const HISTORY =
  "\x1b[32mready\x1b[0m in 80ms\r\nbuilding 50%\rbuilding 100%\r\nError: \x1b[31mboom\x1b[0m\r\n$ ";

/** One running terminal. Typed input echoes, then `reply` prints. */
const fakeTerminal = (
  reply = "",
  initial = HISTORY,
  userInput: TerminalManager.TerminalThreadRead["userInput"] = null,
  /** What the OS reports while output pauses; null when it cannot tell. */
  commandRunning: boolean | null = null,
  /** No terminal until one is opened. */
  startsEmpty = false,
) => {
  let history = initial;
  let exists = !startsEmpty;
  let terminalId = "term-1";
  const writes: Array<string> = [];
  const opens: Array<object> = [];
  /** What reached the terminal, in order: "prompt" for a new shell's first prompt, else input. */
  const order: Array<string> = [];
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const print = (data: string) =>
    Effect.gen(function* () {
      history += data;
      for (const listener of listeners) {
        yield* listener({ type: "output", threadId, terminalId, data });
      }
    });
  const read = (): TerminalManager.TerminalThreadRead => ({
    threadId,
    terminalId,
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
    readThread: (id: string) => Effect.sync(() => (id === threadId && exists ? [read()] : [])),
    open: (input: { readonly terminalId: string }) =>
      Effect.gen(function* () {
        opens.push(input);
        exists = true;
        terminalId = input.terminalId;
        // A shell with a slow profile prints its first prompt well after it starts.
        yield* Effect.forkDetach(
          Effect.sleep("800 millis").pipe(
            Effect.andThen(Effect.sync(() => order.push("prompt"))),
            Effect.andThen(print("\x1b[?2004h$ ")),
          ),
        );
        return {} as never;
      }),
    subscribe: (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      }),
    write: (input: { readonly data: string }) =>
      Effect.suspend(() => {
        writes.push(input.data);
        order.push(input.data);
        return print(input.data.replace(/\r$/, "\r\n") + reply);
      }),
  };
  return { service, writes, opens, order };
};

const callTool = (
  call: { readonly tool: "terminal_read" | "terminal_write"; readonly params: object },
  world: {
    /** Set as the project's own override, so project resolution is part of the check. */
    readonly access: AgentTerminalAccess;
    readonly runtimeMode?: RuntimeMode;
    readonly terminal?: ReturnType<typeof fakeTerminal>;
    /** An MCP client calling instead of an agent in this thread, such as another machine's link. */
    readonly client?: McpInvocationContext.McpClientCaller;
    /** Threads other than this one are archived. */
    readonly archived?: boolean;
  },
) => {
  const terminal = world.terminal ?? fakeTerminal();
  return Effect.gen(function* () {
    const toolkit = yield* TerminalToolkit;
    const result = yield* toolkit
      .handle(call.tool, call.params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return { result: result.at(-1)?.result, writes: terminal.writes, opens: terminal.opens };
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(TerminalHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:terminal"),
              requestNamespace: "provider:terminal",
              ...(world.client === undefined
                ? {
                    thread: {
                      threadId,
                      providerSessionId: "provider:terminal",
                      providerInstanceId: ProviderInstanceId.make("codex"),
                    },
                    client: undefined,
                  }
                : { thread: undefined, client: world.client }),
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed({
                  ...liveThreadShell(id, { runtimeMode: world.runtimeMode ?? "full-access" }),
                  archivedAt:
                    world.archived === true && id !== threadId
                      ? DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")
                      : null,
                }),
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
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeedSome({ workspaceRoot: "/home/user/app" } as Project),
            }),
            NodeCrypto.layer,
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

it.effect("opens a terminal in the thread's folder and types once its shell shows a prompt", () =>
  Effect.gen(function* () {
    // The OS sees no command while the profile loads, which must not count as ready.
    const terminal = fakeTerminal("\x1b[?2004lsrc\r\n\x1b[?2004h$ ", "", null, false, true);
    const call = yield* callTool(
      { tool: "terminal_write", params: { input: "ls" } },
      { access: "read-write", terminal },
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    const { result, opens } = yield* Fiber.join(call);
    expect(terminal.order).toEqual(["prompt", "ls\r"]);
    const terminalId = expect.stringMatching(/^term-1-/);
    expect(opens).toEqual([
      {
        threadId,
        terminalId,
        cwd: "/home/user/app",
        worktreePath: null,
        env: { T3CODE_PROJECT_ROOT: "/home/user/app" },
      },
    ]);
    expect(result).toMatchObject({
      terminalId,
      waitEnded: "command_finished",
      output: "$ ls\nsrc\n$",
    });
  }),
);

it.effect("types into a thread's terminal for an agent on a full-access linked machine", () =>
  Effect.gen(function* () {
    const terminal = fakeTerminal("\x1b[?2004lclean\r\n\x1b[?2004h$ ");
    const { result, writes } = yield* callTool(
      { tool: "terminal_write", params: { threadId, input: "git status --short" } },
      { access: "read-write", terminal, client: link("full-access") },
    );
    expect(writes).toEqual(["git status --short\r"]);
    expect(result).toMatchObject({ terminalId: "term-1", waitEnded: "command_finished" });
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
  {
    name: "typing in an archived thread",
    tool: "terminal_write" as const,
    access: "read-write" as const,
    target: ThreadId.make("thread:archived"),
    archived: true,
    code: "invalid_request",
  },
  {
    name: "typing through a link paired below full access",
    tool: "terminal_write" as const,
    access: "read-write" as const,
    client: link("auto"),
  },
  {
    name: "typing through a full-access link for an agent that runs below it",
    tool: "terminal_write" as const,
    access: "read-write" as const,
    client: link("full-access", { runtimeMode: "auto", interactionMode: "default" }),
  },
  {
    name: "typing for a linked machine where agents may only read",
    tool: "terminal_write" as const,
    access: "read" as const,
    client: link("full-access"),
  },
  {
    name: "typing for an outside client, even one approved for full access",
    tool: "terminal_write" as const,
    access: "read-write" as const,
    client: { sessionId: "session:outside", label: "Desktop app", access: "full-access" as const },
    code: "thread_credential_required",
  },
])(
  "refuses $name",
  ({
    tool,
    access,
    runtimeMode,
    userInput = null,
    client,
    target = client === undefined ? undefined : threadId,
    archived,
    code = "capability_denied",
  }) =>
    Effect.gen(function* () {
      const { result, writes, opens } = yield* callTool(
        {
          tool,
          params: {
            ...(target === undefined ? {} : { threadId: target }),
            ...(tool === "terminal_write" ? { input: "rm -rf build" } : {}),
          },
        },
        {
          access,
          terminal: fakeTerminal("", HISTORY, userInput),
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
          ...(client === undefined ? {} : { client }),
          ...(archived === undefined ? {} : { archived }),
        },
      );
      expect(result).toMatchObject({ code });
      expect([...writes, ...opens]).toEqual([]);
    }),
);
