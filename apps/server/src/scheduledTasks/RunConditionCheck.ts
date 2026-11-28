// @effect-diagnostics nodeBuiltinImport:off -- A check resolves `~/` with the target system's path rules, win32 or posix.
import * as NodePath from "node:path";

import { managedRuntimeModeDenial } from "@t3tools/contracts/managedPolicy";
import {
  RUN_CONDITION_SKIP_EXIT_CODE,
  type ScheduledTaskRunCheck,
} from "@t3tools/contracts/scheduledTask";
import { splitQuotedCommandLine } from "@t3tools/shared/commandLine";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { providerHostEnvironment } from "../policy/managedProviders.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ThreadPageCheckAccess from "../threadPage/ThreadPageCheckAccess.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DETAIL_LENGTH = 300;
// With the block's fixed words and the longest reason, the block stays within 500 characters.
const MAX_UNIT_LENGTH = 150;
const SHELL_OPERATOR = /[|&;<>]/u;

type RunConditionCommandError = "unclosed_quote" | "shell_operator" | "empty";

export type ResolvedRunConditionCommand =
  | { readonly _tag: "command"; readonly command: string; readonly args: ReadonlyArray<string> }
  | { readonly _tag: "error"; readonly error: RunConditionCommandError };

/**
 * One program and its arguments, the same on every system: no shell, no variables, no globbing.
 * `~` and words under `~/` or `~\` are in the home folder, also when quoted.
 */
export function resolveRunConditionCommand(
  text: string,
  host: { readonly home: string; readonly platform: NodeJS.Platform },
): ResolvedRunConditionCommand {
  const words = splitQuotedCommandLine(text);
  if (words === undefined) return { _tag: "error", error: "unclosed_quote" };
  if (words.length === 0) return { _tag: "error", error: "empty" };
  if (words.some((word) => SHELL_OPERATOR.test(word.outsideQuotes))) {
    return { _tag: "error", error: "shell_operator" };
  }
  const path = host.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const [command, ...args] = words.map(({ text: word }) =>
    word === "~"
      ? host.home
      : word.startsWith("~/") || word.startsWith("~\\")
        ? path.join(host.home, word.slice(2))
        : word,
  );
  return { _tag: "command", command: command!, args };
}

/** Why a saved check is refused, or undefined when it can run. */
export function runConditionCommandProblem(text: string): string | undefined {
  const resolved = resolveRunConditionCommand(text, { home: "/", platform: "linux" });
  if (resolved._tag === "command") return undefined;
  return resolved.error === "unclosed_quote"
    ? "The check has a quote that is never closed."
    : resolved.error === "shell_operator"
      ? "The check is one program with its arguments, without a shell. Put pipes, redirects and && in a script and run that."
      : "The check needs a command.";
}

const cleanLine = (line: string, maxLength = MAX_DETAIL_LENGTH): string | null => {
  const clean = line
    .replace(/\s/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ +/gu, " ")
    .trim();
  if (clean === "") return null;
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
};

const lastRawLine = (output: string): string | null =>
  output.split(/\r?\n/u).findLast((line) => line.trim() !== "") ?? null;

const parseObject = (text: string): object | null => {
  try {
    const parsed: unknown = JSON.parse(
      text,
      (key, value: unknown, context?: { source?: string }) => {
        if (key !== "unit" || typeof value !== "number") return value;
        // A fractional or exponent literal can round to a safe integer during JSON parsing.
        const source = context?.source;
        return source && /^-?\d+$/u.test(source) && Number.isSafeInteger(value) ? source : null;
      },
    );
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** What stdout ends with: a JSON object, on one line or over several at any indent, else its last line. */
function stdoutAnswer(
  stdout: string,
): { readonly text: string; readonly json: object | null } | null {
  const output = stdout.trimEnd();
  if (output === "") return null;
  const lines = output.split("\n");
  // From the last line up: an inner object's opening line leaves the outer braces unclosed, so
  // the first line that parses through to the end opens the whole answer.
  let start = output.length + 1;
  for (const line of lines.toReversed()) {
    start -= line.length + 1;
    if (!line.trimStart().startsWith("{")) continue;
    const text = output.slice(start);
    const json = parseObject(text);
    if (json !== null) return { text, json };
  }
  return { text: lines.at(-1)!, json: null };
}

// Read before cleaning and truncating, so a long JSON answer keeps its `reason`.
const jsonReason = (answer: object): string | null =>
  "reason" in answer && typeof answer.reason === "string"
    ? cleanLine(answer.reason)
    : "error" in answer && typeof answer.error === "string"
      ? cleanLine(answer.error)
      : null;

const jsonUnit = (answer: object): string | null =>
  "unit" in answer && typeof answer.unit === "string"
    ? cleanLine(answer.unit, MAX_UNIT_LENGTH)
    : null;

/**
 * `detail`: why the check answered as it did: the `reason` or `error` of the JSON object stdout
 * ends with, else that answer itself; a failed check prefers stderr's last line to a stdout log
 * line. `unit`: that object's `unit`. Output cut at the size cap has lost its real ending, so it
 * is not used.
 */
function runCheckAnswer(
  output: {
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  },
  outcome: "run" | "skip" | "failed",
): { readonly detail: string | null; readonly unit: string | null } {
  const answer = output.stdoutTruncated ? null : stdoutAnswer(output.stdout);
  const unit = answer?.json == null ? null : jsonUnit(answer.json);
  const reason = answer?.json == null ? null : jsonReason(answer.json);
  if (reason !== null || (outcome === "run" && answer?.json != null))
    return { detail: reason, unit };
  const stderrLine = output.stderrTruncated ? null : lastRawLine(output.stderr);
  const stdoutDetail = answer === null ? null : cleanLine(answer.text);
  const stderrDetail = stderrLine === null ? null : cleanLine(stderrLine);
  return {
    detail: outcome === "failed" ? (stderrDetail ?? stdoutDetail) : (stdoutDetail ?? stderrDetail),
    unit,
  };
}

/**
 * The prompt a chat started after its run condition found work gets: the task's prompt, then a
 * block naming the check's reason and unit, so the chat starts on that work instead of looking
 * for it again. It is part of the message, so the chat's history shows what the model read.
 */
export function promptWithRunCondition(
  prompt: string,
  check: ScheduledTaskRunCheck | undefined,
): string {
  if (check?.outcome !== "run") return prompt;
  // Cleaned again, so the block stays bounded whoever built the check.
  const reason = check.detail === null ? null : cleanLine(check.detail);
  const unit = check.unit === undefined ? null : cleanLine(check.unit, MAX_UNIT_LENGTH);
  if (reason === null && unit === null) return prompt;
  const block = [
    "Run condition found work.",
    ...(reason === null ? [] : [`Reason: ${reason}`]),
    ...(unit === null ? [] : [`Unit: ${unit}`]),
  ].join("\n");
  return `${prompt.trimEnd()}\n\n${block}`;
}

export class RunConditionCheck extends Context.Service<
  RunConditionCheck,
  {
    /** Never fails: a check that cannot run answers `failed`, so the chat still starts. */
    readonly run: (input: {
      readonly command: string;
      readonly timeoutSeconds: number;
      readonly cwd: string;
    }) => Effect.Effect<ScheduledTaskRunCheck>;
  }
>()("t3/scheduledTasks/RunConditionCheck") {}

const failed = (
  failure: NonNullable<ScheduledTaskRunCheck["failure"]>,
  detail: string | null,
  exitCode: number | null = null,
): ScheduledTaskRunCheck => ({ outcome: "failed", failure, exitCode, detail });

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const threadPageAccess = yield* ThreadPageCheckAccess.ThreadPageCheckAccess;
  // A check runs without approval, so a policy that forbids full access forbids it.
  const policyDenial = managedRuntimeModeDenial(managedPolicy.summary, "full-access");

  const run: RunConditionCheck["Service"]["run"] = Effect.fn("RunConditionCheck.run")(
    function* (input) {
      if (policyDenial !== undefined) return failed("policy", policyDenial);
      const resolved = resolveRunConditionCommand(input.command, {
        home: yield* HostProcess.HomeDirectory,
        platform: yield* HostProcess.Platform,
      });
      if (resolved._tag === "error") {
        return failed("invalid_command", runConditionCommandProblem(input.command) ?? null);
      }
      const host = yield* HostProcess.Environment;
      const shell = providerHostEnvironment(managedPolicy.summary, host);
      // ProcessRunner extends the server's own environment, so a removed variable must be unset.
      const removed = Object.keys(host).filter((name) => !(name in shell));
      const env: NodeJS.ProcessEnv = {
        ...shell,
        ...Object.fromEntries(removed.map((name) => [name, undefined])),
      };
      // The ThreadPage grant ends with the check, so a program it leaves behind cannot use it.
      return yield* threadPageAccess.grant.pipe(
        Effect.flatMap((threadPageEnv) =>
          processRunner.run({
            command: resolved.command,
            args: resolved.args,
            cwd: input.cwd,
            env: { ...env, ...threadPageEnv },
            timeout: Duration.seconds(input.timeoutSeconds),
            // Closed at once, so a program that reads stdin to its end does not wait out the time limit.
            stdin: "",
            timeoutBehavior: "timedOutResult",
            outputMode: "truncate",
            maxOutputBytes: MAX_OUTPUT_BYTES,
          }),
        ),
        Effect.scoped,
        Effect.map((output): ScheduledTaskRunCheck => {
          if (output.timedOut) return failed("timeout", null);
          const exitCode = output.code === null ? null : Number(output.code);
          if (exitCode === 0) {
            const { detail, unit } = runCheckAnswer(output, "run");
            return {
              outcome: "run",
              failure: null,
              exitCode,
              detail,
              ...(unit === null ? {} : { unit }),
            };
          }
          if (exitCode === RUN_CONDITION_SKIP_EXIT_CODE) {
            return {
              outcome: "skip",
              failure: null,
              exitCode,
              detail: runCheckAnswer(output, "skip").detail,
            };
          }
          return failed("exit_code", runCheckAnswer(output, "failed").detail, exitCode);
        }),
        Effect.catch((error) =>
          Effect.succeed(
            failed(
              "not_started",
              cleanLine(
                "cause" in error && error.cause instanceof Error
                  ? error.cause.message
                  : error.message,
              ),
            ),
          ),
        ),
      );
    },
  );

  return RunConditionCheck.of({ run });
});

export const layer = Layer.effect(RunConditionCheck, make);
