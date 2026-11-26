import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { CLAUDE_LIMIT_RESET_TIMINGS, ClaudeLimitResetTimings } from "./claudeLimitResetTerminal.ts";

const ROWS = 50;
const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const RULE = "─".repeat(80);

export type FakeClaudeFirstRunScreen = "theme" | "notes" | "trust" | "chrome" | "fullscreen";

const TRUST_OPTIONS = ["No, exit", "Yes, I trust this folder"];

const firstRunLines = (screen: FakeClaudeFirstRunScreen, trustSelected: number) => {
  switch (screen) {
    case "theme":
      return [
        " Let's get started.",
        "",
        " Choose the text style that looks best with your terminal",
        " ❯ 1. Dark mode",
        "   2. Light mode",
      ];
    case "notes":
      return [" Security notes:", "", " Claude can make mistakes", "", " Press Enter to continue…"];
    case "trust":
      return [
        " Do you trust the files in this folder?",
        "",
        ...TRUST_OPTIONS.map(
          (option, index) => `${index === trustSelected ? " ❯" : "  "} ${index + 1}. ${option}`,
        ),
      ];
    case "chrome":
      return [" Claude in Chrome extension detected", " ❯ 1. Got it"];
    case "fullscreen":
      return [" Try the new fullscreen renderer?", " ❯ 1. Yes", "   2. Not now"];
  }
};

/** A dialog Claude opens instead of answering; its first option is highlighted. */
export interface FakeClaudeDialog {
  readonly lines: ReadonlyArray<string>;
  readonly options: ReadonlyArray<string>;
  /** Printed under the command when the dialog is left with Esc or its other option. */
  readonly kept: string;
  /** Printed when Enter picks the highlighted first option, which uses the reset. */
  readonly used: string;
}

export type FakeClaudeReaction =
  | { readonly answer: string; readonly uses?: true }
  | { readonly dialog: FakeClaudeDialog };

export interface FakeClaudeScript {
  readonly firstRun?: ReadonlyArray<FakeClaudeFirstRunScreen>;
  readonly signedOut?: boolean;
  /** Lines shown in place of the prompt, as a screen the reader does not know. */
  readonly unknownScreen?: ReadonlyArray<string>;
  /** Typeahead rows shown under the prompt while its input starts with `/`. */
  readonly suggestions?: ReadonlyArray<string>;
  /** What Enter on each line leads to; a line not listed is answered as an unknown command. */
  readonly reactions: Readonly<Record<string, FakeClaudeReaction>>;
  /** Called as a reset is used, for a fixture whose usage changes with it. */
  readonly onUse?: (command: string) => void;
  /**
   * Holds each spawn, its process already started, until `release` is done. The hold is one of
   * the adapter's stoppable waits: an interrupt there stops the process.
   */
  readonly holdSpawn?: {
    readonly reached: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  /** Draws each answer in two parts, cut mid-line, the second a task after the first. */
  readonly splitAnswers?: true;
}

const confirmReset = (
  kind: string,
  detail: string,
  kept: string,
  used: string,
): FakeClaudeReaction => ({
  dialog: {
    lines: [` Use a ${kind}?`, " Refills your weekly limits now", ` ${detail}`],
    options: [`Yes, use my ${kind}`, "No, keep it"],
    kept,
    used,
  },
});

/** An account with a weekly grant kept for a limit, a full one usable any time, and a Fable one. */
export const GRANTS_REACTIONS: FakeClaudeScript["reactions"] = {
  "/limit-reset": {
    dialog: {
      lines: [" Which reset do you want to use?"],
      options: ["Weekly reset · 2 left", "Full reset · 1 left"],
      kept: "Resets kept · run /limit-reset when you want one · first expires Nov 20",
      used: "Weekly limits reset · your weekly reset day stays Monday · 1 weekly reset left",
    },
  },
  "/limit-reset 5-hour": {
    answer: "No 5-hour reset to use · you can use a weekly reset or full reset",
  },
  "/limit-reset weekly": confirmReset(
    "weekly reset",
    "2 weekly resets left · use by Dec 1",
    "Weekly reset kept · run /limit-reset at a limit to use it · use by Dec 1",
    "Weekly limits reset · your weekly reset day stays Monday · 1 weekly reset left",
  ),
  "/limit-reset full": confirmReset(
    "full reset",
    "1 full reset left · use by Nov 20",
    "Full reset kept · run /limit-reset whenever you want to use it · use by Nov 20",
    "Limits reset · your weekly reset day stays Monday · no full resets left",
  ),
  "/limit-reset fable": {
    answer:
      "Your Fable reset is usable once you reach a limit it refills · you can use a weekly reset or full reset",
  },
};

/** `reactions` with `command`'s dialog answering `used` once its reset is used. */
export function answeringClaim(
  reactions: FakeClaudeScript["reactions"],
  command: string,
  used: string,
): FakeClaudeScript["reactions"] {
  const reaction = reactions[command];
  if (reaction === undefined || !("dialog" in reaction)) {
    throw new Error(`${command} opens no dialog.`);
  }
  return { ...reactions, [command]: { dialog: { ...reaction.dialog, used } } };
}

export interface FakeClaude {
  readonly adapter: PtyAdapter.PtyAdapter["Service"];
  readonly spawns: ReadonlyArray<PtyAdapter.PtySpawnInput>;
  /** Every write, one key each. */
  readonly keys: ReadonlyArray<string>;
  /** Every line Enter sent from the prompt. */
  readonly submitted: ReadonlyArray<string>;
  /** The commands that used a reset: a dialog's first option, or an answer that uses one. */
  readonly used: ReadonlyArray<string>;
  /** Processes started and not yet killed or exited. */
  readonly alive: () => number;
  /** The most processes that ran at once. */
  readonly peak: () => number;
  /** Opens `command`'s dialog on the latest process, as if Claude opened it by itself. */
  readonly showDialog: (command: string) => void;
  /** Draws the latest process's screen again unchanged, as Claude's renderer does by itself. */
  readonly redraw: () => void;
}

/**
 * An in-process `claude` for the `/limit-reset` reader: it redraws its whole screen after every
 * key, the way Claude's renderer leaves the terminal, and uses a reset only when told to.
 */
export function makeFakeClaude(script: FakeClaudeScript): FakeClaude {
  const spawns: Array<PtyAdapter.PtySpawnInput> = [];
  const keys: Array<string> = [];
  const submitted: Array<string> = [];
  const used: Array<string> = [];
  let alive = 0;
  let peak = 0;
  let latest:
    | { readonly showDialog: (command: string) => void; readonly redraw: () => void }
    | undefined;

  const use = (command: string) => {
    used.push(command);
    script.onUse?.(command);
  };

  const spawnProcess = (): PtyAdapter.PtyProcess => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
    const firstRun = [...(script.firstRun ?? [])];
    const transcript: Array<string> = [" ✻ Welcome to Claude Code", ""];
    let trustSelected = 0;
    let input = "";
    let dialog: (FakeClaudeDialog & { readonly command: string; selected: number }) | undefined;
    let exited = false;
    let splitLine: string | undefined;
    alive++;
    peak = Math.max(peak, alive);
    const end = () => {
      if (exited) return;
      exited = true;
      alive--;
    };

    const screen = (): ReadonlyArray<string> => {
      if (script.signedOut) {
        return [" Select login method:", "", " ❯ 1. Claude account with subscription"];
      }
      const pending = firstRun[0];
      if (pending !== undefined) return firstRunLines(pending, trustSelected);
      if (script.unknownScreen !== undefined) return script.unknownScreen;
      if (dialog !== undefined) {
        return [
          ...transcript,
          "",
          ...dialog.lines,
          // Claude's reset dialogs hide the option numbers its other selects show.
          ...dialog.options.map(
            (option, index) => `${index === dialog!.selected ? " ❯" : "  "} ${option}`,
          ),
          "",
          " Esc to cancel",
        ];
      }
      return [
        ...transcript,
        "",
        RULE,
        input === "" ? '❯ \x1b[2mTry "fix the failing test"\x1b[22m' : `❯ ${input}`,
        RULE,
        ...(input.startsWith("/") ? (script.suggestions ?? []) : ["  ? for shortcuts"]),
      ];
    };

    const emit = (data: string) => {
      for (const listener of dataListeners) listener(data);
    };

    const render = () => {
      const lines = screen();
      if (lines.length > ROWS) throw new Error("The fake Claude screen outgrew the terminal.");
      let frame = "";
      for (let row = 0; row < ROWS; row++) frame += `\x1b[${row + 1};1H\x1b[2K${lines[row] ?? ""}`;
      const split = splitLine;
      splitLine = undefined;
      const at = split === undefined ? -1 : frame.lastIndexOf(split);
      if (split === undefined || at === -1) return emit(frame);
      const cut = at + Math.ceil(split.length / 2);
      emit(frame.slice(0, cut));
      // The terminal parses each chunk a task later, so this rest lands after the first part shows.
      // @effect-diagnostics-next-line globalTimers:off - Only a host timer runs after xterm's own.
      setTimeout(() => {
        if (!exited) emit(frame.slice(cut));
      });
    };

    const exit = (exitCode: number) => {
      end();
      for (const listener of exitListeners) listener({ exitCode, signal: null });
    };

    const answer = (command: string, text: string) => {
      transcript.push(`❯ ${command}`, `  ⎿  ${text}`);
      if (script.splitAnswers) splitLine = `  ⎿  ${text}`;
    };

    const pressFirstRun = (screenName: FakeClaudeFirstRunScreen, key: string) => {
      if (screenName === "trust") {
        if (key === DOWN) trustSelected = Math.min(trustSelected + 1, TRUST_OPTIONS.length - 1);
        if (key !== ENTER) return;
        if (TRUST_OPTIONS[trustSelected] === "No, exit") return exit(1);
        firstRun.shift();
        return;
      }
      if (key === ENTER || (screenName === "fullscreen" && key === ESCAPE)) firstRun.shift();
    };

    const pressDialog = (open: NonNullable<typeof dialog>, key: string) => {
      if (key === DOWN) open.selected = Math.min(open.selected + 1, open.options.length - 1);
      if (key !== ENTER && key !== ESCAPE) return;
      dialog = undefined;
      if (key === ENTER && open.selected === 0) {
        use(open.command);
        answer(open.command, open.used);
      } else {
        answer(open.command, open.kept);
      }
    };

    const submit = () => {
      const line = input;
      input = "";
      submitted.push(line);
      const reaction = script.reactions[line];
      if (reaction === undefined) return answer(line, `Unknown skill: ${line.slice(1)}`);
      if ("dialog" in reaction) {
        dialog = { ...reaction.dialog, command: line, selected: 0 };
        return;
      }
      if (reaction.uses) use(line);
      answer(line, reaction.answer);
    };

    latest = {
      showDialog: (command) => {
        const reaction = script.reactions[command];
        if (reaction === undefined || !("dialog" in reaction)) {
          throw new Error(`${command} opens no dialog.`);
        }
        dialog = { ...reaction.dialog, command, selected: 0 };
        render();
      },
      redraw: render,
    };

    const press = (key: string) => {
      if (script.signedOut || script.unknownScreen !== undefined) return;
      const pending = firstRun[0];
      if (pending !== undefined) return pressFirstRun(pending, key);
      if (dialog !== undefined) return pressDialog(dialog, key);
      if (key === ENTER) return submit();
      if (key.startsWith(ESCAPE)) return;
      input += key;
    };

    return {
      pid: 4242,
      write: (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        keys.push(text);
        if (exited) return;
        press(text);
        if (!exited) render();
      },
      resize: () => {},
      kill: end,
      onData: (listener) => {
        dataListeners.add(listener);
        render();
        return () => dataListeners.delete(listener);
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    };
  };

  return {
    adapter: {
      spawn: (input) =>
        Effect.gen(function* () {
          spawns.push(input);
          const process = spawnProcess();
          if (script.holdSpawn !== undefined) {
            yield* Deferred.succeed(script.holdSpawn.reached, undefined);
            yield* Deferred.await(script.holdSpawn.release).pipe(
              Effect.interruptible,
              Effect.onInterrupt(() => Effect.sync(process.kill)),
            );
          }
          return process;
        }),
    },
    spawns,
    keys,
    submitted,
    used,
    alive: () => alive,
    peak: () => peak,
    showDialog: (command) => {
      if (latest === undefined) throw new Error("No fake Claude is running.");
      latest.showDialog(command);
    },
    redraw: () => {
      if (latest === undefined) throw new Error("No fake Claude is running.");
      latest.redraw();
    },
  };
}

/** The clock stands still under `it.effect`, so pauses are skipped; the limits stay. */
const FAKE_CLAUDE_TIMINGS = {
  ...CLAUDE_LIMIT_RESET_TIMINGS,
  keyDelay: 0,
  settle: 0,
  dialogGuard: 0,
};

/** Runs `effect` with `fake` as the terminal `claude` runs in. */
export const withFakeClaude = <A, E, R>(fake: FakeClaude, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(PtyAdapter.PtyAdapter, fake.adapter),
    Effect.provideService(ClaudeLimitResetTimings, FAKE_CLAUDE_TIMINGS),
  );
