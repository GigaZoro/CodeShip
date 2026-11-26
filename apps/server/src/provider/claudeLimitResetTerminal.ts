/**
 * Drives an account's own `claude` in a hidden terminal to read and use its `/limit-reset`
 * resets. It answers only the first-run screens it knows, and sends every key only onto the
 * fully drawn screen that key is meant for: any other screen ends the run instead.
 */
import type { ServerProviderResetKind } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import xtermHeadless from "@xterm/headless";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import {
  GRANTED_DESCRIPTION,
  KIND_ARGUMENTS,
  RESET_KINDS,
  WEEKLY_SESSION_DESCRIPTION,
  isChooseDialog,
  parseConfirmDialog,
  parseGrantedClaimAnswer,
  parseKeptLine,
  parseKindAnswer,
  parseNoOfferAnswer,
  parseWeeklySessionClaimAnswer,
  type ClaudeClaimAnswer,
  type ClaudeLimitResetGrant,
  type GrantedTexts,
  type WeeklySessionTexts,
} from "./claudeLimitResetText.ts";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

const COLUMNS = 200;
const ROWS = 50;
const COMMAND = "/limit-reset";
/** The prompt that makes Claude see the 5-hour limit before it offers the weekly 5-hour reset. */
const LIMIT_CHECK_PROMPT = "hi";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const ENTER = "\r";
/** Each first-run screen is answered at most this often before the run gives up on it. */
const MAX_ANSWERS_PER_SCREEN = 3;
/** Claude's footer under an idle prompt, which also shows that its key handlers are mounted. */
const IDLE_FOOTERS = ["shift+tab to cycle", "? for shortcuts"];
/** Claude's status line while a turn runs. */
const TURN_RUNNING = "esc to interrupt";
const RULE = /^─{20,}$/;
/** Variables of the parent Claude session that would make the child behave as its subagent. */
const PARENT_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
];
/** Resets belong to the account's own login, so API keys, gateways and cloud routes stay out. */
const isOtherSessionVariable = (name: string) =>
  PARENT_SESSION_VARIABLES.includes(name) ||
  name.startsWith("ANTHROPIC_") ||
  name.startsWith("CLAUDE_CODE_USE_");

const FAILURES = {
  signedOut: "Claude is signed out.",
  unrecognizedScreen: "Claude showed a screen this server does not recognize.",
  programChanged: "Claude now offers a different reset program than its flags said.",
  readFailed: "Claude's limit resets could not be read.",
  lowPriority: "Claude holds resets while the account continues at lower priority.",
  unavailable: "Claude could not use the reset, and nothing was used. Try again in a moment.",
  accountChanged:
    "Claude is signed in to another account now, so nothing was used. Refresh and try again.",
  unconfirmed:
    "Claude could not confirm the reset. If you are still limited in a moment, try again.",
} as const;

export class ClaudeLimitResetError extends Schema.TaggedError<ClaudeLimitResetError>()(
  "ClaudeLimitResetError",
  {
    reason: Schema.Literals(Object.keys(FAILURES) as Array<keyof typeof FAILURES>),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return FAILURES[this.reason];
  }
}

type FailureReason = ClaudeLimitResetError["reason"];

const fail = (reason: FailureReason, cause?: unknown) =>
  Effect.fail(new ClaudeLimitResetError({ reason, ...(cause === undefined ? {} : { cause }) }));

/** Milliseconds. */
export interface ClaudeLimitResetTimings {
  readonly keyDelay: number;
  /** How long an idle prompt is left before the first key, so Claude finishes starting up. */
  readonly settle: number;
  /** A first-run screen still shown this long after its answer is answered again. */
  readonly reanswer: number;
  /** Claude ignores keys on its confirm dialog for a moment after opening it. */
  readonly dialogGuard: number;
  readonly startup: number;
  readonly step: number;
  /** A turn sent only to meet the 5-hour limit. */
  readonly turn: number;
}

export const CLAUDE_LIMIT_RESET_TIMINGS: ClaudeLimitResetTimings = {
  keyDelay: 150,
  settle: 3_000,
  reanswer: 1_500,
  dialogGuard: 2_000,
  startup: 60_000,
  step: 20_000,
  turn: 90_000,
};

/** Tests replace it with zero pauses and the same limits. */
export const ClaudeLimitResetTimings = Context.Reference<ClaudeLimitResetTimings>(
  "t3/provider/ClaudeLimitResetTimings",
  { defaultValue: () => CLAUDE_LIMIT_RESET_TIMINGS },
);

/** The two programs' texts and whether their flags are on now. */
export interface ClaudeLimitResetPrograms {
  readonly granted?: GrantedTexts;
  readonly weeklySession?: WeeklySessionTexts;
}

export interface ClaudeLimitResetTerminalOptions {
  readonly binaryPath: string;
  /** The account's Claude environment: `CLAUDE_CONFIG_DIR` names an added account's folder. */
  readonly environment: NodeJS.ProcessEnv;
  /** A folder of the server's own, so Claude's trust prompt never names a user's project. */
  readonly cwd: string;
  /** Read again right before Enter: Claude may have refreshed its flags since the run began. */
  readonly programs: Effect.Effect<ClaudeLimitResetPrograms, ClaudeLimitResetError>;
  /**
   * A claim's check that the login still holds the account it claims for, run right before every
   * Enter, since the login can switch while Claude starts.
   */
  readonly holdsAccount?: Effect.Effect<void, ClaudeLimitResetError>;
}

const pause = (ms: number) => (ms > 0 ? Effect.sleep(ms) : Effect.void);

function readLine(term: Terminal, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

/** The input line's text without dim cells, which carry Claude's placeholder and hints. */
function inputText(term: Terminal, row: number): string {
  const line = term.buffer.active.getLine(row);
  if (line === undefined) return "";
  let text = "";
  for (let column = 2; column < line.length; column++) {
    const cell = line.getCell(column);
    if (cell === undefined || cell.isDim()) continue;
    text += cell.getChars() || " ";
  }
  const typed = text.trimEnd();
  return typed.startsWith('Try "') ? "" : typed;
}

interface View {
  readonly screen: ReadonlyArray<string>;
  readonly all: ReadonlyArray<string>;
  /** The prompt box's typed text; absent while a dialog or another screen replaces it. */
  readonly prompt?: { readonly input: string; readonly idle: boolean };
}

function readView(term: Terminal): View {
  const buffer = term.buffer.active;
  const all = Array.from({ length: buffer.length }, (_, row) => readLine(term, row));
  const top = buffer.baseY;
  const screen = all.slice(top);
  for (let row = screen.length - 2; row >= 1; row--) {
    if (!screen[row]!.startsWith("❯")) continue;
    if (!RULE.test(screen[row - 1]!.trim()) || !RULE.test(screen[row + 1]!.trim())) continue;
    const footer = screen.slice(row + 2).join("\n");
    return {
      screen,
      all,
      prompt: {
        input: inputText(term, top + row),
        idle: IDLE_FOOTERS.some((marker) => footer.includes(marker)),
      },
    };
  }
  return { screen, all };
}

/** Each answer Claude printed under an echo of `command`, oldest first. */
function answersTo(lines: ReadonlyArray<string>, command: string): ReadonlyArray<string> {
  const answers: Array<string> = [];
  for (let row = 0; row < lines.length - 1; row++) {
    if (lines[row]!.trimEnd() !== `❯ ${command}`) continue;
    const first = /^\s+⎿\s+(.*)$/.exec(lines[row + 1]!);
    if (first === null) continue;
    let answer = first[1]!.trimEnd();
    for (let next = row + 2; next < lines.length && /^ {5,}\S/.test(lines[next]!); next++) {
      answer += ` ${lines[next]!.trim()}`;
    }
    answers.push(answer);
  }
  return answers;
}

type FirstRunScreen = "theme" | "notes" | "trust" | "chrome" | "fullscreen";
const FIRST_RUN_SCREENS: ReadonlyArray<readonly [FirstRunScreen, string]> = [
  ["theme", "Choose the text style that looks best with your terminal"],
  ["trust", "Yes, I trust this folder"],
  ["chrome", "Claude in Chrome extension detected"],
  ["fullscreen", "Try the new fullscreen renderer?"],
  ["notes", "Press Enter to continue"],
];
const LOGIN_SCREEN = "Select login method:";

const screenText = (view: View) => view.screen.join("\n");
const isSignedOut = (view: View) => screenText(view).includes(LOGIN_SCREEN);
const firstRunScreen = (view: View) =>
  view.prompt === undefined
    ? FIRST_RUN_SCREENS.find(([, marker]) => screenText(view).includes(marker))?.[0]
    : undefined;
const trustSelected = (view: View) =>
  view.screen.some((line) => /^\s*❯\s*(?:\d+\.\s*)?Yes, I trust this folder/.test(line));

type ResetProgram = "granted" | "weeklySession";
const PROGRAM_DESCRIPTIONS: Record<ResetProgram, string> = {
  granted: GRANTED_DESCRIPTION,
  weeklySession: WEEKLY_SESSION_DESCRIPTION,
};
const otherProgram = (program: ResetProgram): ResetProgram =>
  program === "granted" ? "weeklySession" : "granted";

/** Why Enter would not run `command` for `program`; undefined when it would. */
function commandLineRefusal(
  view: View,
  command: string,
  program: ResetProgram,
): FailureReason | undefined {
  if (view.prompt?.input !== command) return "unrecognizedScreen";
  const other = PROGRAM_DESCRIPTIONS[otherProgram(program)];
  if (view.screen.some((line) => line.includes(other))) return "programChanged";
  // Enter runs a command selected in Claude's typeahead instead of the typed one.
  const selected = view.screen
    .map((line) => /^\s+❯\s+(\/\S+)/.exec(line)?.[1])
    .find((name) => name !== undefined);
  return selected !== undefined && selected !== COMMAND ? "unrecognizedScreen" : undefined;
}

type CommandResult =
  | { readonly _tag: "answer"; readonly text: string }
  | { readonly _tag: "dialog"; readonly view: View };

/** One running `claude`; every key goes through `press`, which first checks the screen. */
const openSession = Effect.fn("ClaudeLimitResetTerminal.openSession")(function* (
  options: ClaudeLimitResetTerminalOptions,
  timings: ClaudeLimitResetTimings,
) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  if (Option.isNone(pty)) return yield* fail("readFailed");
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(options.environment)) {
    if (!isOtherSessionVariable(name)) environment[name] = value;
  }
  // Claude prints dates in its own zone; in UTC they parse to the same instant on any host.
  environment.TZ = "UTC";
  const executable = yield* resolveClaudeSdkExecutablePath(
    options.binaryPath,
    environment,
    options.cwd,
  );
  // Older npm installs resolve to a script entry that the SDK also runs with node.
  const launch = executable.endsWith(".js")
    ? { shell: "node", args: [executable] }
    : { shell: executable, args: [] };
  const term = yield* Effect.acquireRelease(
    Effect.sync(
      () => new Terminal({ cols: COLUMNS, rows: ROWS, allowProposedApi: true, scrollback: 500 }),
    ),
    (term) => Effect.sync(() => term.dispose()),
  );
  const changes = yield* Queue.sliding<void>(1);
  let exited = false;
  /** Output chunks the terminal has not parsed yet; the screen is current only at zero. */
  let unparsed = 0;
  /** Output chunks received so far, so a check before a key knows whether output came during it. */
  let received = 0;
  const process = yield* PtyAdapter.spawnScoped(
    pty.value,
    { ...launch, cwd: options.cwd, cols: COLUMNS, rows: ROWS, env: environment },
    {
      onData: (data) => {
        unparsed++;
        received++;
        term.write(data, () => {
          unparsed--;
          Queue.offerUnsafe(changes, undefined);
        });
      },
      onExit: () => {
        exited = true;
        Queue.offerUnsafe(changes, undefined);
      },
    },
  ).pipe(
    Effect.catch((cause) => fail("readFailed", cause)),
    // Reads and claims hold the login's lock, so a start that never finishes must not hold it.
    Effect.timeoutOrElse({ duration: timings.startup, orElse: () => fail("readFailed") }),
  );

  /**
   * Waits until `read` finds something on the screen. The deadline is fixed before the key that
   * starts the step is sent, so a clock that moves while the key is handled still ends the wait.
   */
  const waitUntil = Effect.fn("ClaudeLimitResetTerminal.waitUntil")(function* <A>(
    read: (view: View) => A | undefined,
    deadline: number,
  ) {
    while (true) {
      const view = readView(term);
      if (isSignedOut(view)) return yield* fail("signedOut");
      const found = read(view);
      if (found !== undefined) return found;
      if (exited) return yield* fail("readFailed");
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return yield* fail("unrecognizedScreen");
      yield* Queue.take(changes).pipe(Effect.timeoutOption(remaining));
    }
  });

  const deadlineIn = (ms: number) => Effect.map(Clock.currentTimeMillis, (now) => now + ms);

  /**
   * Sends `keys` once all output is parsed and `refuse` accepts that screen, then waits for what
   * they lead to. The check and the write run in one synchronous step, so no output lands between.
   * `before` and a claim's account check run on that settled screen first; output during them
   * means another wait, so they run again and still hold when the keys go.
   */
  const press = Effect.fn("ClaudeLimitResetTerminal.press")(function* <A>(
    keys: string,
    refuse: (view: View) => FailureReason | undefined,
    read: (view: View) => A | undefined,
    ms = timings.step,
    before?: Effect.Effect<void, ClaudeLimitResetError>,
  ) {
    const checks = [before, keys === ENTER ? options.holdsAccount : undefined].filter(
      (check) => check !== undefined,
    );
    const deadline = yield* deadlineIn(ms);
    let checkedAt: number | undefined;
    while (true) {
      const step = yield* waitUntil(
        (view): { readonly refused?: FailureReason; readonly check?: true } | undefined => {
          if (unparsed > 0 || exited) return undefined;
          const refused = refuse(view);
          if (refused !== undefined) return { refused };
          if (checks.length > 0 && checkedAt !== received) return { check: true };
          process.write(keys);
          return {};
        },
        deadline,
      );
      if (step.refused !== undefined) return yield* fail(step.refused);
      if (!step.check) return yield* waitUntil(read, deadline);
      if (checkedAt !== undefined && (yield* Clock.currentTimeMillis) >= deadline) {
        return yield* fail("unrecognizedScreen");
      }
      checkedAt = received;
      yield* Effect.all(checks, { discard: true });
    }
  });

  const idlePrompt = (view: View) =>
    view.prompt?.idle && view.prompt.input === "" ? view : undefined;

  /** Answers one first-run screen; a key the screen missed or refused is retried by `start`. */
  const answerFirstRun = Effect.fn("ClaudeLimitResetTerminal.answerFirstRun")(
    function* (state: FirstRunScreen) {
      if (state === "trust" && !trustSelected(readView(term))) {
        yield* press(
          DOWN,
          (view) =>
            firstRunScreen(view) === "trust" && !trustSelected(view)
              ? undefined
              : "unrecognizedScreen",
          (view) => (trustSelected(view) ? true : undefined),
          timings.reanswer,
        );
      }
      yield* press(
        state === "fullscreen" ? ESCAPE : ENTER,
        (view) =>
          firstRunScreen(view) === state && (state !== "trust" || trustSelected(view))
            ? undefined
            : "unrecognizedScreen",
        (view) => (firstRunScreen(view) !== state ? true : undefined),
        timings.reanswer,
      );
    },
    Effect.catchIf(
      (error) => error.reason === "unrecognizedScreen",
      () => Effect.void,
    ),
  );

  /** Answers Claude's first-run screens until its prompt is idle. */
  const start = Effect.gen(function* () {
    const deadline = yield* deadlineIn(timings.startup);
    const answers = new Map<FirstRunScreen, number>();
    while (true) {
      const state = yield* waitUntil(
        (view) => (idlePrompt(view) ? "prompt" : firstRunScreen(view)),
        deadline,
      );
      if (state === "prompt") break;
      const count = (answers.get(state) ?? 0) + 1;
      if (count > MAX_ANSWERS_PER_SCREEN) return yield* fail("unrecognizedScreen");
      answers.set(state, count);
      yield* answerFirstRun(state);
    }
    yield* pause(timings.settle);
    yield* waitUntil(idlePrompt, yield* deadlineIn(timings.step));
  });

  /** Types `text` one key at a time, each only onto the exact input it expects. */
  const type = Effect.fn("ClaudeLimitResetTerminal.type")(function* (text: string) {
    for (let index = 0; index < text.length; index++) {
      const typed = text.slice(0, index).trimEnd();
      const next = text.slice(0, index + 1).trimEnd();
      yield* pause(timings.keyDelay);
      yield* press(
        text[index]!,
        (view) => (view.prompt?.input === typed ? undefined : "unrecognizedScreen"),
        (view) => (view.prompt?.input === next ? true : undefined),
      );
    }
  });

  /** Claude runs the granted program whenever its flag is on, and the weekly one only otherwise. */
  const checkProgram = Effect.fn("ClaudeLimitResetTerminal.checkProgram")(function* (
    program: ResetProgram,
  ) {
    const programs = yield* options.programs;
    const runs = programs.granted
      ? "granted"
      : programs.weeklySession
        ? "weeklySession"
        : undefined;
    if (runs !== program) return yield* fail("programChanged");
  });

  /**
   * Types `command`, a `/limit-reset` line, and presses Enter only while that line is what Enter
   * runs. Returns how often Claude had answered it before, and what Enter led to: an answer line,
   * or one of the two dialogs this reader knows (`texts` absent: an answer only).
   */
  const runCommand = Effect.fn("ClaudeLimitResetTerminal.runCommand")(function* (
    command: string,
    program: ResetProgram,
    texts: GrantedTexts | undefined,
    now: DateTime.Utc,
  ) {
    yield* checkProgram(program);
    yield* type(command);
    const answered = answersTo(readView(term).all, command).length;
    const result = yield* press(
      ENTER,
      (view) => commandLineRefusal(view, command, program),
      (view): CommandResult | undefined => {
        const answer = answerAfter(command, answered)(view);
        if (answer !== undefined) return { _tag: "answer", text: answer };
        if (view.prompt !== undefined || texts === undefined) return undefined;
        if (parseConfirmDialog(view.screen, texts, now) || isChooseDialog(view.screen, texts)) {
          return { _tag: "dialog", view };
        }
        return undefined;
      },
      timings.step,
      checkProgram(program),
    );
    return { answered, result };
  });

  return { start, type, press, waitUntil, deadlineIn, runCommand };
});

type Session = Effect.Success<ReturnType<typeof openSession>>;

/**
 * The newest answer to `command` past the first `answered`. Claude draws its empty prompt after
 * the answer, so until that prompt shows, the answer's text may still be arriving.
 */
const answerAfter = (command: string, answered: number) => (view: View) => {
  if (view.prompt?.input !== "") return undefined;
  const answers = answersTo(view.all, command);
  return answers.length > answered ? answers.at(-1)! : undefined;
};

/** Leaves an open dialog with Esc and returns the line Claude prints for the kept reset. */
const leaveDialog = Effect.fn("ClaudeLimitResetTerminal.leaveDialog")(function* (
  session: Session,
  command: string,
  answered: number,
  texts: GrantedTexts,
  now: DateTime.Utc,
  timings: ClaudeLimitResetTimings,
) {
  yield* pause(timings.dialogGuard);
  return yield* session.press(
    ESCAPE,
    (view) =>
      view.prompt === undefined &&
      (parseConfirmDialog(view.screen, texts, now) || isChooseDialog(view.screen, texts))
        ? undefined
        : "unrecognizedScreen",
    answerAfter(command, answered),
  );
});

/** Reads every grant `/limit-reset` offers, without using any. */
export const readClaudeLimitResets = Effect.fn("readClaudeLimitResets")(function* (
  options: ClaudeLimitResetTerminalOptions,
  texts: GrantedTexts,
) {
  const timings = yield* ClaudeLimitResetTimings;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* openSession(options, timings);
      yield* session.start;
      const now = yield* DateTime.now;
      const { answered, result } = yield* session.runCommand(COMMAND, "granted", texts, now);
      if (result._tag === "answer") {
        const answer = parseNoOfferAnswer(result.text, texts, now);
        if (answer === undefined) return yield* fail("unrecognizedScreen");
        if (answer._tag === "transient") return yield* fail("readFailed");
        if (answer._tag === "lowPriority") return yield* fail("lowPriority");
        return answer.grants;
      }
      const kept = yield* leaveDialog(session, COMMAND, answered, texts, now, timings);
      const confirm = parseConfirmDialog(result.view.screen, texts, now);
      if (parseKeptLine(kept, texts, confirm?.kind) === undefined) {
        return yield* fail("unrecognizedScreen");
      }
      // The first dialog shows one offer; each kind's own command shows all of them, usable or not.
      const grants: Array<ClaudeLimitResetGrant> = [];
      for (const kind of RESET_KINDS) {
        const grant = yield* readKind(session, kind, texts, now, timings);
        if (grant !== undefined) grants.push(grant);
      }
      return grants;
    }),
  );
});

const readKind = Effect.fn("ClaudeLimitResetTerminal.readKind")(function* (
  session: Session,
  kind: ServerProviderResetKind,
  texts: GrantedTexts,
  now: DateTime.Utc,
  timings: ClaudeLimitResetTimings,
) {
  const command = `${COMMAND} ${KIND_ARGUMENTS[kind]}`;
  const { answered, result } = yield* session.runCommand(command, "granted", texts, now);
  if (result._tag === "answer") {
    const answer = parseKindAnswer(result.text, kind, texts);
    if (answer === undefined) return yield* fail("unrecognizedScreen");
    if (answer._tag === "none") return undefined;
    return {
      kind,
      usableNow: false,
      ...(answer.requiresLimit ? { requiresLimit: true } : {}),
    } satisfies ClaudeLimitResetGrant;
  }
  const confirm = parseConfirmDialog(result.view.screen, texts, now);
  if (confirm === undefined || confirm.kind !== kind) return yield* fail("unrecognizedScreen");
  const kept = parseKeptLine(
    yield* leaveDialog(session, command, answered, texts, now, timings),
    texts,
    kind,
  );
  if (kept === undefined) return yield* fail("unrecognizedScreen");
  return {
    kind,
    resetsLeft: confirm.resetsLeft,
    ...(confirm.expiresAt === undefined ? {} : { expiresAt: confirm.expiresAt }),
    usableNow: true,
    requiresLimit: kept.requiresLimit,
  } satisfies ClaudeLimitResetGrant;
});

/** Uses one granted reset of `kind`: `/limit-reset <kind>`, then Yes on Claude's confirm dialog. */
export const claimClaudeGrantedReset = Effect.fn("claimClaudeGrantedReset")(function* (
  options: ClaudeLimitResetTerminalOptions,
  texts: GrantedTexts,
  kind: ServerProviderResetKind,
) {
  const timings = yield* ClaudeLimitResetTimings;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* openSession(options, timings);
      yield* session.start;
      const now = yield* DateTime.now;
      const command = `${COMMAND} ${KIND_ARGUMENTS[kind]}`;
      const { answered, result } = yield* session.runCommand(command, "granted", texts, now);
      const answerText =
        result._tag === "answer"
          ? result.text
          : yield* confirmDialog(session, command, answered, texts, kind, now, timings);
      const answer = parseGrantedClaimAnswer(answerText, kind, texts, now);
      if (answer === undefined) return yield* fail("unrecognizedScreen");
      return answer;
    }),
  );
});

const confirmDialog = Effect.fn("ClaudeLimitResetTerminal.confirmDialog")(function* (
  session: Session,
  command: string,
  answered: number,
  texts: GrantedTexts,
  kind: ServerProviderResetKind,
  now: DateTime.Utc,
  timings: ClaudeLimitResetTimings,
) {
  yield* pause(timings.dialogGuard);
  return yield* session.press(
    ENTER,
    (view) => {
      const dialog =
        view.prompt === undefined ? parseConfirmDialog(view.screen, texts, now) : undefined;
      return dialog?.kind === kind && dialog.yesSelected ? undefined : "unrecognizedScreen";
    },
    answerAfter(command, answered),
  );
});

/**
 * Uses the weekly 5-hour reset, which Claude offers only once a turn has met the 5-hour limit and
 * then uses without a dialog: one short prompt, then `/limit-reset`.
 */
export const claimClaudeWeeklySessionReset = Effect.fn("claimClaudeWeeklySessionReset")(function* (
  options: ClaudeLimitResetTerminalOptions,
  texts: WeeklySessionTexts,
) {
  const timings = yield* ClaudeLimitResetTimings;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* openSession(options, timings);
      yield* session.start;
      yield* session.type(LIMIT_CHECK_PROMPT);
      // The turn has ended once its echo is in the transcript and nothing offers to interrupt it;
      // the second look, after a pause, skips the moment before the turn's spinner appears.
      const turnEnded = (view: View) =>
        view.all.some((line) => line.trimEnd() === `❯ ${LIMIT_CHECK_PROMPT}`) &&
        !view.screen.some((line) => line.includes(TURN_RUNNING)) &&
        view.prompt?.idle &&
        view.prompt.input === ""
          ? true
          : undefined;
      yield* session.press(
        ENTER,
        (view) => (view.prompt?.input === LIMIT_CHECK_PROMPT ? undefined : "unrecognizedScreen"),
        turnEnded,
        timings.turn,
      );
      yield* pause(timings.settle);
      yield* session.waitUntil(turnEnded, yield* session.deadlineIn(timings.turn));
      const now = yield* DateTime.now;
      const { result } = yield* session.runCommand(COMMAND, "weeklySession", undefined, now);
      if (result._tag !== "answer") return yield* fail("unrecognizedScreen");
      const answer: ClaudeClaimAnswer | undefined = parseWeeklySessionClaimAnswer(
        result.text,
        texts,
        now,
      );
      if (answer === undefined) return yield* fail("unrecognizedScreen");
      return answer;
    }),
  );
});
