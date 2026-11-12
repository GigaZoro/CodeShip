// @effect-diagnostics nodeBuiltinImport:off -- A check resolves `~/` with the target system's path rules, win32 or posix.
import * as NodePath from "node:path";

import {
  RUN_CONDITION_SKIP_EXIT_CODE,
  type ScheduledTaskRunCheck,
  managedRuntimeModeDenial,
} from "@t3tools/contracts";
import { splitQuotedCommandLine } from "@t3tools/shared/commandLine";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { providerHostEnvironment } from "../policy/managedProviders.ts";
import * as ProcessRunner from "../processRunner.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DETAIL_LENGTH = 300;
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

const cleanLine = (line: string): string | null => {
  const clean = line
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
  if (clean === "") return null;
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH - 1)}…` : clean;
};

const lastRawLine = (output: string): string | null =>
  output.split(/\r?\n/u).findLast((line) => line.trim() !== "") ?? null;

// Read before cleaning and truncating, so a long JSON line keeps its `reason`.
const jsonDetail = (line: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    if ("reason" in parsed && typeof parsed.reason === "string") return cleanLine(parsed.reason);
    if ("error" in parsed && typeof parsed.error === "string") return cleanLine(parsed.error);
    return null;
  } catch {
    return null;
  }
};

/**
 * Why the check answered as it did: the last stdout line's JSON `reason` or `error`, else that
 * line itself; a failed check prefers stderr's last line to a stdout log line. Output cut at the
 * size cap has lost its real last line, so it is not used.
 */
function runCheckDetail(
  output: {
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  },
  failedCheck: boolean,
): string | null {
  const stdoutLine = output.stdoutTruncated ? null : lastRawLine(output.stdout);
  const stderrLine = output.stderrTruncated ? null : lastRawLine(output.stderr);
  const fromJson = stdoutLine === null ? null : jsonDetail(stdoutLine);
  if (fromJson !== null) return fromJson;
  const stdoutDetail = stdoutLine === null ? null : cleanLine(stdoutLine);
  const stderrDetail = stderrLine === null ? null : cleanLine(stderrLine);
  return failedCheck ? (stderrDetail ?? stdoutDetail) : (stdoutDetail ?? stderrDetail);
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
      return yield* processRunner
        .run({
          command: resolved.command,
          args: resolved.args,
          cwd: input.cwd,
          env,
          timeout: Duration.seconds(input.timeoutSeconds),
          // Closed at once, so a program that reads stdin to its end does not wait out the time limit.
          stdin: "",
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
          maxOutputBytes: MAX_OUTPUT_BYTES,
        })
        .pipe(
          Effect.map((output): ScheduledTaskRunCheck => {
            if (output.timedOut) return failed("timeout", null);
            const exitCode = output.code === null ? null : Number(output.code);
            if (exitCode === 0) {
              return {
                outcome: "run",
                failure: null,
                exitCode,
                detail: runCheckDetail(output, false),
              };
            }
            if (exitCode === RUN_CONDITION_SKIP_EXIT_CODE) {
              return {
                outcome: "skip",
                failure: null,
                exitCode,
                detail: runCheckDetail(output, false),
              };
            }
            return failed("exit_code", runCheckDetail(output, true), exitCode);
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
