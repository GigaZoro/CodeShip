import * as NodeUtil from "node:util";

import { redactSensitiveText } from "@t3tools/shared/redaction";
import { escapeRegExp } from "@t3tools/shared/String";

/** Redaction and the reason line read at most this much of a CLI's output. */
export const PROVIDER_OUTPUT_MAX_CHARS = 4_096;
const PROVIDER_FAILURE_REASON_MAX_LENGTH = 240;

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const PAIRING_URL_PATTERN = /\/pair#/i;
const SIGN_IN_URL_PATTERN =
  /^https?:\/\/(?:accounts\.google\.com|[^/?#]+\/(?:[^?#]*\/)?(?:oauth2?|authorize|device|login|signin|sign-in|sso)(?:[/?#]|$))/i;
const SLACK_WEBHOOK_PATTERN = /^https?:\/\/hooks\.slack\.com\//i;
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]+)(["']?\s*[=:]\s*)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|["']?[^\s"',;}]+["']?)/g;
const SECRET_KEY_PATTERN = /api[_-]?key|token|secret|password|passwd|private[_-]?key/i;

const CRASH_LOCATION_PATTERN = /:\d+(?::\d+)?$|^\d+\s*\|/u;
const CARET_LINE_PATTERN = /^\^+$/u;
const CRASH_CARET_MAX_LINE = 8;
const ERROR_HEADER_PATTERN = /^[\w.$]*(?:Error|Exception)(?:\s*\[[^\]]+\])?:/iu;

/** Matches a home folder with either separator, JSON-escaped backslashes and any casing. */
function homeFolderPattern(home: string): RegExp {
  const segments = home.split(/[\\/]+/u).filter((part, index) => index === 0 || part.length > 0);
  const separator = String.raw`(?:\\\\|\\|/)`;
  return new RegExp(`${segments.map(escapeRegExp).join(separator)}(?![\\w-]|\\.\\w)`, "giu");
}

function redactUrl(url: string): string {
  if (PAIRING_URL_PATTERN.test(url)) return "[pairing-url]";
  if (SIGN_IN_URL_PATTERN.test(url)) return "[sign-in-url]";
  if (SLACK_WEBHOOK_PATTERN.test(url)) return "[redacted]";
  const queryStart = url.search(/[?#]/u);
  return queryStart === -1 ? url : `${url.slice(0, queryStart + 1)}[redacted]`;
}

/** The head of a CLI's output, cut back to a whole line so a split secret cannot slip past redaction. */
export function providerOutputHead(text: string): string {
  if (text.length <= PROVIDER_OUTPUT_MAX_CHARS) return text;
  const head = text.slice(0, PROVIDER_OUTPUT_MAX_CHARS);
  const lastNewline = head.lastIndexOf("\n");
  return lastNewline > 0 ? head.slice(0, lastNewline) : head;
}

/** Strips terminal codes, home paths, sign-in and pairing links, URL queries, credentials and emails from a provider CLI's output. */
export function redactProviderOutput(
  text: string,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let result = NodeUtil.stripVTControlCharacters(text).replaceAll("\0", "");
  const homes = new Map<string, string>();
  for (const home of [environment.HOME, environment.USERPROFILE, homeDirectory]) {
    if (typeof home === "string" && home.length > 1) homes.set(home.toLowerCase(), home);
  }
  for (const home of homes.values()) {
    result = result.replace(homeFolderPattern(home), "~");
  }
  return redactSensitiveText(result)
    .replace(HTTP_URL_PATTERN, redactUrl)
    .replace(ASSIGNMENT_PATTERN, (assignment, key: string, separator: string) =>
      SECRET_KEY_PATTERN.test(key) ? `${key}${separator}[redacted]` : assignment,
    )
    .trim();
}

/**
 * A CLI names why it stopped on its first line; later lines are stack frames or context.
 * An uncaught Node or Bun crash starts with the failing source line and a caret instead, so the
 * error line after them wins there.
 */
export function providerFailureReason(redactedOutput: string): string | undefined {
  const lines = redactedOutput
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const first = lines[0];
  if (first === undefined) return undefined;
  const caret = CRASH_LOCATION_PATTERN.test(first)
    ? lines.findIndex((part) => CARET_LINE_PATTERN.test(part))
    : -1;
  const afterSource = caret > 0 && caret <= CRASH_CARET_MAX_LINE ? lines.slice(caret + 1) : [];
  const line =
    afterSource.find((part) => ERROR_HEADER_PATTERN.test(part)) ?? afterSource[0] ?? first;
  return line.length > PROVIDER_FAILURE_REASON_MAX_LENGTH
    ? `${line.slice(0, PROVIDER_FAILURE_REASON_MAX_LENGTH - 1)}…`
    : line;
}

/** Why a CLI failed, in its own words: one redacted line of what it printed. */
export function providerOutputReason(
  text: string,
  homeDirectory: string,
  environment?: NodeJS.ProcessEnv,
): string | undefined {
  return providerFailureReason(
    redactProviderOutput(providerOutputHead(text), homeDirectory, environment),
  );
}

/** Why a CLI command exited non-zero: its stderr, or stdout when stderr is empty. */
export function commandFailureReason(
  output: { readonly stdout: string; readonly stderr: string },
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const text = output.stderr.trim() === "" ? output.stdout : output.stderr;
  return providerOutputReason(text, homeDirectory, environment);
}

/** A status message that ends with the CLI's own reason when it gave one. */
export function withProviderFailureReason(summary: string, reason: string | undefined): string {
  return reason === undefined ? `${summary}.` : `${summary}: ${reason}`;
}
