import {
  PROVIDER_MCP_ENV_NAME_PATTERN,
  PROVIDER_MCP_HEADER_NAME_PATTERN,
  PROVIDER_MCP_NEW_SERVER_NAME_MAX_LENGTH,
  PROVIDER_MCP_NEW_SERVER_NAME_PATTERN,
  type ProviderMcpServerConfig,
} from "@t3tools/contracts";
import { t } from "~/i18n";

export type McpServerKind = "remote" | "local";

export interface McpServerForm {
  readonly name: string;
  readonly kind: McpServerKind;
  readonly url: string;
  readonly headers: string;
  readonly command: string;
  readonly env: string;
}

export type McpServerFormField = "name" | "url" | "headers" | "command" | "env";

export type McpServerFormResult =
  | { readonly ok: true; readonly name: string; readonly server: ProviderMcpServerConfig }
  | { readonly ok: false; readonly errors: Partial<Record<McpServerFormField, string>> };

const URL_MAX_LENGTH = 2_048;
const COMMAND_MAX_LENGTH = 1_024;
const MAX_ARGS = 64;
const MAX_ENTRIES = 64;

/**
 * Splits a pasted command line the way a shell would for plain words and quoted arguments.
 * Undefined means a quote was left open.
 */
export function splitCommandLine(line: string): ReadonlyArray<string> | undefined {
  const words: Array<string> = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && line[index + 1] === '"') {
        word += '"';
        index += 1;
      } else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

/** Reads one `name<separator>value` pair per line, skipping blank lines. */
function parseKeyValueLines(
  text: string,
  separator: "=" | ":",
  namePattern: RegExp,
  label: "header" | "variable",
): { readonly values: Record<string, string> } | { readonly error: string } {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    const name = at > 0 ? line.slice(0, at).trim() : "";
    if (!name || !namePattern.test(name)) {
      return {
        error:
          label === "header"
            ? t("Line {line} needs a header name, then {separator} and its value.", {
                line: index + 1,
                separator,
              })
            : t("Line {line} needs a variable name, then {separator} and its value.", {
                line: index + 1,
                separator,
              }),
      };
    }
    values[name] = line.slice(at + 1).trim();
  }
  if (Object.keys(values).length > MAX_ENTRIES) {
    return { error: t("Use at most {max} lines.", { max: MAX_ENTRIES }) };
  }
  return { values };
}

export function readMcpServerForm(form: McpServerForm): McpServerFormResult {
  const errors: Partial<Record<McpServerFormField, string>> = {};
  const name = form.name.trim();
  if (!name) errors.name = t("Enter a name.");
  else if (name.length > PROVIDER_MCP_NEW_SERVER_NAME_MAX_LENGTH) {
    errors.name = t("Use at most {max} characters.", {
      max: PROVIDER_MCP_NEW_SERVER_NAME_MAX_LENGTH,
    });
  } else if (!PROVIDER_MCP_NEW_SERVER_NAME_PATTERN.test(name)) {
    errors.name = t("Use only letters, numbers, hyphens, and underscores.");
  }

  if (form.kind === "remote") {
    const url = form.url.trim();
    if (!url) errors.url = t("Enter the server's URL.");
    else if (url.length > URL_MAX_LENGTH)
      errors.url = t("Use at most {max} characters.", { max: URL_MAX_LENGTH });
    else if (!URL.canParse(url) || !/^https?:$/u.test(new URL(url).protocol)) {
      errors.url = t("Enter an http:// or https:// URL.");
    }
    const headers = parseKeyValueLines(
      form.headers,
      ":",
      PROVIDER_MCP_HEADER_NAME_PATTERN,
      "header",
    );
    if ("error" in headers) errors.headers = headers.error;
    if (Object.keys(errors).length > 0 || "error" in headers) return { ok: false, errors };
    return { ok: true, name, server: { transport: "http", url, headers: headers.values } };
  }

  const words = splitCommandLine(form.command);
  if (words === undefined) errors.command = t("Close the quote in the command.");
  else if (words.length === 0) errors.command = t("Enter the command that starts the server.");
  else if (form.command.trim().length > COMMAND_MAX_LENGTH || words.length > MAX_ARGS + 1) {
    errors.command = t("This command is too long.");
  }
  const env = parseKeyValueLines(form.env, "=", PROVIDER_MCP_ENV_NAME_PATTERN, "variable");
  if ("error" in env) errors.env = env.error;
  if (Object.keys(errors).length > 0 || words === undefined || "error" in env) {
    return { ok: false, errors };
  }
  const [command, ...args] = words;
  return {
    ok: true,
    name,
    server: { transport: "stdio", command: command!, args, env: env.values },
  };
}
