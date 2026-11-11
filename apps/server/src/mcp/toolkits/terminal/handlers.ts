import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ProjectId,
  TERMINAL_TOOL_DEFAULT_LINES,
  TERMINAL_TOOL_DEFAULT_WAIT_SECONDS,
  type TerminalEvent,
  type TerminalToolReadTerminal,
  type TerminalToolWriteResult,
} from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import {
  normalizeTerminalOutput,
  TERMINAL_OUTPUT_TAIL_CHARS,
  terminalOutputPlainText,
} from "@t3tools/shared/terminalOutput";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import { FORWARDED_WAIT_CHUNK_MS } from "../../../peer/PeerForwarding.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import { BRACKETED_PASTE_ON, lineEditorReading } from "../../../terminal/lineEditor.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertFullAccess,
  type Caller,
  loadCaller,
  readCaller,
  resolveThreadId,
  threadNotFound,
  unavailable,
} from "../../threadAccess.ts";
import { TerminalToolkit } from "./tools.ts";

// Folding replays cursor moves from the start, so only the recent raw output is folded.
const RAW_TAIL_CHARS = 1024 * 1024;

/** A terminal's recent output as the user sees it: redraws applied, colours removed. */
function terminalReadOutput(
  history: string,
  lines: number,
  cols: number | null,
): { readonly output: string; readonly truncated: boolean } {
  let raw = history;
  let truncated = false;
  if (raw.length > RAW_TAIL_CHARS) {
    // Start on a fresh line so the cut never lands inside an escape sequence.
    const start = raw.length - RAW_TAIL_CHARS;
    const newline = raw.indexOf("\n", start);
    raw = raw.slice(newline === -1 ? start : newline + 1);
    truncated = true;
  }
  const folded = normalizeTerminalOutput(raw, TERMINAL_OUTPUT_TAIL_CHARS, cols ?? undefined);
  const all = terminalOutputPlainText(folded.text)
    .split("\n")
    .map((line) => line.trimEnd());
  while (all.length > 0 && all.at(-1) === "") all.pop();
  const kept = all.slice(-lines);
  return {
    output: kept.join("\n"),
    truncated: truncated || folded.truncated || kept.length < all.length,
  };
}

/**
 * Output after `after` when it is an earlier cursor of the same history, else all of it. It starts
 * at the beginning of the cursor's line: shells redraw typed input relative to the prompt there.
 */
function outputSince(
  session: TerminalManager.TerminalThreadRead,
  after: string | undefined,
  lines: number,
) {
  const [epoch, generation, offset] = (after ?? "").split(".");
  const [currentEpoch, currentGeneration, currentOffset] = session.cursor.split(".");
  const added = Number(currentOffset) - Number(offset);
  const cut =
    after !== undefined &&
    epoch === currentEpoch &&
    generation === currentGeneration &&
    Number.isInteger(added) &&
    added >= 0 &&
    added <= session.history.length
      ? session.history.length - added
      : 0;
  const since = session.history.slice(
    cut === 0 ? 0 : session.history.lastIndexOf("\n", cut - 1) + 1,
  );
  return { ...terminalReadOutput(since, lines, session.cols), cursor: session.cursor };
}

const USER_ACTIVE_MS = 5_000;

// Checked this often while output pauses; the shell running no command means it finished.
const SETTLE = "500 millis";
// The shell may print nothing for a while mid-command; the agent reads the rest with `after`.
const QUIET_SETTLES = 6;

const waitForTerminal = Effect.fn("mcp.terminalWait")(function* (
  terminals: TerminalManager.TerminalManager["Service"],
  target: { readonly threadId: string; readonly terminalId: string },
  events: Queue.Queue<TerminalEvent>,
  waitSeconds: number,
) {
  if (waitSeconds === 0) return "not_waited" as const;
  const watch = Effect.gen(function* () {
    let reading = false;
    let carry = "";
    let quiet = 0;
    let checked = false;
    while (true) {
      const next = yield* Queue.take(events).pipe(Effect.timeoutOption(SETTLE));
      if (Option.isNone(next)) {
        quiet += 1;
        // Shells without bracketed paste (bash 3.2, sh, PowerShell, cmd) never announce their prompt.
        if (!checked) {
          checked = true;
          if ((yield* terminals.commandRunning(target)) === false)
            return "command_finished" as const;
        }
        if (quiet >= QUIET_SETTLES) return "output_quiet" as const;
        continue;
      }
      const event = next.value;
      if (event.type === "exited" || event.type === "closed") return "terminal_exited" as const;
      if (event.type !== "output") continue;
      quiet = 0;
      checked = false;
      const text = carry + event.data;
      carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
      reading = lineEditorReading(text, reading);
      if (reading) return "command_finished" as const;
    }
  });
  return yield* watch.pipe(
    Effect.timeoutOption(`${waitSeconds} seconds`),
    Effect.map(Option.getOrElse(() => "time_limit" as const)),
  );
});

const accessLevel = Effect.fn("mcp.terminalAccessLevel")(function* (projectId: ProjectId) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
  return resolveProjectSettings(current, projectId).settings.agentTerminalAccess;
});

const denied = (message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `${message} The change applies right away.`,
  });

/** Another machine's agent, calling through that machine's link to this one. */
const fromLink = (context: Caller) => context.scope.client?.linked === true;

/** Where the setting lives, as the agent reading the refusal sees it. */
const settingPlace = (context: Caller) => (fromLink(context) ? "on that machine" : "here");

const readOff = (context: Caller) =>
  denied(
    `Agents may not read terminals ${settingPlace(context)}. Ask the user to set Agent terminal access to Read output in Settings > Browser & devices.`,
  );

const writeOff = (context: Caller) =>
  denied(
    `Agents may only read terminals ${settingPlace(context)}. Ask the user to set Agent terminal access to Read and run commands in Settings > Browser & devices.`,
  );

/** Agents in a thread here, or on a linked machine through its link, with full access. */
const assertMayType = (context: Caller) =>
  context.caller === undefined && !fromLink(context)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message:
            "Typing in a terminal needs an agent in a T3.CodeShip thread, on this machine or a linked one.",
        }),
      )
    : assertFullAccess(
        context,
        context.caller !== undefined
          ? "Typing in a terminal runs commands without approval, so it needs this thread in Full access and default mode. Ask the user to run the command, or for this machine run it in your own shell."
          : "Typing in a terminal runs commands without approval, so it needs a link paired with full access and a calling thread in Full access and default mode. To allow it, link that machine again with full access.",
      );

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const describeTerminals = (sessions: ReadonlyArray<TerminalManager.TerminalThreadRead>) =>
  sessions.map((session) => `${session.terminalId} (${session.label})`).join(", ");

/** A link's request goes idle while the terminal is watched, and T3 Connect drops idle ones. */
const LINKED_MAX_WAIT_SECONDS = FORWARDED_WAIT_CHUNK_MS / 1000;

const watchTerminal = (
  terminals: TerminalManager.TerminalManager["Service"],
  target: { readonly threadId: string; readonly terminalId: string },
  events: Queue.Queue<TerminalEvent>,
) =>
  Effect.acquireRelease(
    terminals.subscribe((event) =>
      event.threadId === target.threadId && event.terminalId === target.terminalId
        ? Queue.offer(events, event).pipe(Effect.asVoid)
        : Effect.void,
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

/** Room for a slow shell profile; past it, the shell gets the input while it still starts. */
const SHELL_START_SECONDS = 15;

/**
 * A new shell is ready at its first prompt, or once it printed and went quiet. The OS check
 * `waitForTerminal` makes would pass while a profile still loads. Returns why it failed to start.
 */
const waitForShellStart = Effect.fn("mcp.terminalShellStart")(function* (
  events: Queue.Queue<TerminalEvent>,
) {
  let reading = false;
  let carry = "";
  let printed = false;
  let quiet = 0;
  while (true) {
    const next = yield* Queue.take(events).pipe(Effect.timeoutOption(SETTLE));
    if (Option.isNone(next)) {
      if (printed && ++quiet >= QUIET_SETTLES) return undefined;
      continue;
    }
    const event = next.value;
    if (event.type === "error") return event.message;
    if (event.type === "exited" || event.type === "closed") return "the shell exited.";
    if (event.type !== "output") continue;
    printed = true;
    quiet = 0;
    const text = carry + event.data;
    carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
    reading = lineEditorReading(text, reading);
    if (reading) return undefined;
  }
});

/** A new terminal in the thread's folder, opened as the terminal panel opens one. */
const openThreadTerminal = Effect.fn("mcp.terminalOpenForAgent")(function* (
  terminals: TerminalManager.TerminalManager["Service"],
  thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "worktreePath">,
  existingTerminalIds: ReadonlyArray<string>,
) {
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) return yield* invalid("The thread's project was not found.");
  const folder = {
    project: { cwd: project.value.workspaceRoot },
    worktreePath: thread.worktreePath,
  };
  const cwd = projectScriptCwd(folder);
  // Unique, as the panel's are when it cannot see every terminal: another agent may open one now.
  const unique = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
  const target = { threadId: thread.id, terminalId: nextTerminalId(existingTerminalIds, unique) };
  const failure = yield* Effect.scoped(
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<TerminalEvent>();
      yield* watchTerminal(terminals, target, events);
      yield* terminals
        .open({
          ...target,
          cwd,
          worktreePath: thread.worktreePath,
          env: projectScriptRuntimeEnv(folder),
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(`Could not open a terminal in ${cwd}: ${error.message}`),
          ),
        );
      // Typed before its first prompt, a command's wait would end at that prompt.
      return yield* waitForShellStart(events).pipe(
        Effect.timeoutOption(`${SHELL_START_SECONDS} seconds`),
        Effect.map(Option.getOrUndefined),
      );
    }),
  );
  if (failure !== undefined)
    return yield* invalid(`The terminal opened in ${cwd} did not start: ${failure}`);
  const opened = (yield* terminals.readThread(thread.id)).find(
    (session) => session.terminalId === target.terminalId,
  );
  return opened ?? (yield* unavailable());
});

export const layer = McpToolAccess.toLayer(TerminalToolkit, {
  terminal_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const threadId = yield* resolveThreadId(context, input.threadId);
      const thread = yield* context.threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(unavailable));
      if (thread === null || thread.deletedAt !== null) {
        return yield* threadNotFound(context.threads, threadId, "The thread was not found.");
      }
      if ((yield* accessLevel(thread.projectId)) === "none") return yield* readOff(context);
      const terminals = yield* TerminalManager.TerminalManager;
      const sessions = (yield* terminals.readThread(threadId)).filter(
        (session) => input.terminalId === undefined || session.terminalId === input.terminalId,
      );
      if (input.terminalId !== undefined && sessions.length === 0) {
        return yield* invalid(
          `This thread has no terminal ${input.terminalId}. Omit terminalId to read all of them.`,
        );
      }
      if (input.after !== undefined && sessions.length > 1) {
        return yield* invalid("A cursor belongs to one terminal. Pass its terminalId with after.");
      }
      const lines = input.lines ?? TERMINAL_TOOL_DEFAULT_LINES;
      return {
        terminals: sessions.map((session): TerminalToolReadTerminal => ({
          terminalId: session.terminalId,
          label: session.label,
          cwd: session.cwd,
          status: session.status,
          commandRunning: session.hasRunningSubprocess,
          exitCode: session.exitCode,
          ...outputSince(session, input.after, lines),
        })),
      };
    }),
  ),
  // A linked machine's thread is named by id, so this is also how an agent elsewhere types here.
  terminal_write: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* loadCaller();
        const threadId = yield* resolveThreadId(context, input.threadId);
        const thread =
          threadId === context.caller?.id
            ? context.caller
            : yield* context.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        if (thread === null || thread.deletedAt !== null) {
          return yield* threadNotFound(context.threads, threadId, "The thread was not found.");
        }
        if (thread.archivedAt !== null) {
          return yield* invalid(
            "The thread is archived, which closed its terminals. Use another thread.",
          );
        }
        if ((yield* accessLevel(thread.projectId)) !== "read-write")
          return yield* writeOff(context);
        const terminals = yield* TerminalManager.TerminalManager;
        const sessions = yield* terminals.readThread(thread.id);
        const running = sessions.filter((candidate) => candidate.status === "running");
        const session =
          input.terminalId !== undefined
            ? sessions.find((candidate) => candidate.terminalId === input.terminalId)
            : running.length === 0
              ? yield* openThreadTerminal(
                  terminals,
                  thread,
                  sessions.map((candidate) => candidate.terminalId),
                )
              : running.length === 1
                ? running[0]
                : undefined;
        if (session === undefined) {
          return yield* invalid(
            input.terminalId === undefined
              ? `Pass terminalId. Its running terminals: ${describeTerminals(running)}.`
              : `This thread has no terminal ${input.terminalId}. Omit terminalId to use its running terminal or open one.${sessions.length === 0 ? "" : ` Its terminals: ${describeTerminals(sessions)}.`}`,
          );
        }
        if (session.status !== "running") {
          return yield* invalid(
            `Terminal ${session.terminalId} is not running. Omit terminalId to use the thread's running terminal or open a new one.`,
          );
        }
        const userInput = session.userInput;
        if (
          userInput !== null &&
          (userInput.lineDirty || (yield* Clock.currentTimeMillis) - userInput.at < USER_ACTIVE_MS)
        ) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: `The user ${userInput.lineDirty ? "has an unsent command" : "is typing"} in terminal ${session.terminalId}, so typing there would mix with theirs. ${context.caller === undefined ? "Ask them first." : "Ask them first, or use your own shell."}`,
          });
        }
        const target = { threadId: thread.id, terminalId: session.terminalId };
        const events = yield* Queue.unbounded<TerminalEvent>();
        // Subscribe before typing so no output is missed.
        yield* watchTerminal(terminals, target, events);
        yield* terminals
          .write(
            { ...target, data: input.enter === false ? input.input : `${input.input}\r` },
            "agent",
          )
          .pipe(Effect.mapError(unavailable));
        const waitSeconds = input.waitSeconds ?? TERMINAL_TOOL_DEFAULT_WAIT_SECONDS;
        const waitEnded = yield* waitForTerminal(
          terminals,
          target,
          events,
          fromLink(context) ? Math.min(waitSeconds, LINKED_MAX_WAIT_SECONDS) : waitSeconds,
        );
        const after = (yield* terminals.readThread(target.threadId)).find(
          (candidate) => candidate.terminalId === target.terminalId,
        );
        return {
          terminalId: target.terminalId,
          waitEnded,
          ...(after === undefined
            ? { output: "", truncated: false, cursor: session.cursor }
            : outputSince(after, session.cursor, TERMINAL_TOOL_DEFAULT_LINES)),
        } satisfies TerminalToolWriteResult;
      }).pipe(Effect.scoped),
    { caller: assertMayType },
  ),
});
