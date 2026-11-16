import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OtlpSerialization } from "effect/observability";

const REDACTED = "[redacted]";

const SECRET_TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgl(?:pat|dt|rt|ft|soat|oas|agent|ptt|cbt|imt|ffct)-[A-Za-z0-9_=-]{20,}/g,
  /\b(?:xox[a-z]|xapp|xwfp)-[A-Za-z0-9+/=%_-]{10,}/gi,
  /\bsq0(?:atp|csp)-[A-Za-z0-9_-]{22,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:gsk|hf)_[A-Za-z0-9]{20,}/g,
];

// A name ending in one of these holds a credential: `Authorization`, `x-api-key`,
// `desktopBootstrapToken`, `client_secret`, but not `inputTokens`.
const CREDENTIAL_NAME =
  "authorization|cookie|(?:api|access|private|secret)[-_]?key|token|secret|passw(?:or)?d|credentials?";
const CREDENTIAL_KEY = new RegExp(`(?:${CREDENTIAL_NAME})$`, "i");
const HEADER_NAME = String.raw`(?:proxy-)?authorization|(?:set-)?cookie|(?:x-)?api[-_]?key`;
const HEADER_KEY = new RegExp(`^(?:${HEADER_NAME})$`, "i");

// The scheme stays readable, as in `Authorization: Bearer [redacted]`. A folded header line can put
// the credential on the next, indented line.
const SCHEME_GAP = String.raw`(?:[ \t]*\r?\n)?[ \t]+`;
const AUTH_SCHEME = String.raw`(?:basic|bearer|digest|negotiate)${SCHEME_GAP}`;

// A YAML comment to its line's end, which JSON text writes `\n`. A bounded comment keeps a failed
// match from rescanning a line.
const LINE_COMMENT = String.raw`#[^\r\n\\]{0,200}`;
const LINE_END = String.raw`(\r?\n|\\r\\n|\\n|$)`;
// A YAML block scalar, `|` or `>` with its indicators, holds the lines indented below it.
const BLOCK_HEADER = String.raw`[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:${LINE_COMMENT})?${LINE_END}`;
// A YAML anchor or tag before a value, as in `password: &pw "…"` or `!!binary |`. A node has at most
// one of each; bounded names keep a failed match from rescanning a run of them. A verbatim tag,
// `!<tag:yaml.org,2002:str>`, can hold a comma.
const YAML_PROPERTY = String.raw`(?:!<[^\s<>]{0,128}>|[&!][^\s,[\]{}]{0,128})[ \t]+`;

// A header line's value runs to its end, as in `Authorization: Digest username="…", response="…"`,
// and on over indented lines while one ends in a separator, as a folded header continues. A Basic,
// Bearer or Negotiate credential is one word.
const CREDENTIAL_HEADER = new RegExp(
  String.raw`(?<![\w-])(${HEADER_NAME})([ \t]*:[ \t]*)(?:((?:basic|bearer|negotiate)${SCHEME_GAP})[^\s"'\\]+|(digest${SCHEME_GAP})?(?!(?:\\r)?\\n)\S[^\r\n]*(?:(?<=[,;][ \t]*)\r?\n[ \t]+\S[^\r\n]*)*)`,
  "gi",
);
const HEADER_SCHEME = new RegExp(AUTH_SCHEME, "iy");

// util.inspect prints a string with line breaks as quoted pieces joined by `+` at line ends.
const STRING_JOIN = String.raw`[ \t]*\+[ \t]*\r?\n[ \t]*`;
// A piece's closing quote after its escaped line break, then the `+` and the next piece's quote.
const PIECE_BREAK = String.raw`["'${"`"}]${STRING_JOIN}["'${"`"}]`;
const LINE_BREAK = String.raw`\r?\n|(?:\\r)?\\n(?:${PIECE_BREAK})?`;
// A YAML block sequence's entry, which may hold nothing but nested lines below it.
const SEQUENCE_MARK = String.raw`-(?:[ \t]|${LINE_END})`;

// Spaces and line breaks, as JSON and printed text may put around a quoted name's separator.
const GAP = String.raw`(?:[ \t\r\n]|\\[rn](?:${PIECE_BREAK})?)*`;
// A header list, flat as Node's `rawHeaders` or in `[name, value]` pairs, puts a quoted header name,
// then a comma, before the header's value, which Node also takes as a number.
const QUOTE = String.raw`\\?["'${"`"}]`;
const HEADER_PAIR = String.raw`(?<=["'${"`"}])(?:${HEADER_NAME})${QUOTE}${GAP},${GAP}(?=${QUOTE}|[[\d]|-\d)`;
// A credential's name and separator: `"token":`, `token: `, `?token=`, a Map's `'token' =>`, a
// symbol key's `Symbol(token):`. JSON may put line breaks around a quoted name's separator; other
// values may start on the next line, or below blank or escaped breaks when a comment, a list entry or
// indented, as YAML writes them: an unindented quote after an escaped break closes the string.
const CREDENTIAL_FIELD = new RegExp(
  String.raw`(?<![\w.-])[\w.-]*?(?:${CREDENTIAL_NAME})(?:\\?["']${GAP}(?:=>|[:=])[ \t\r\n]*|(?:(?<=Symbol\([^()\r\n]{0,128})\)\]?[ \t]*|\\?[ \t]*)(?:=>|[:=])[ \t]*)(?:\r?\n[ \t]*(?=\S)|(?:(?:${LINE_BREAK})[ \t]*)*(?:${LINE_BREAK})(?:[ \t]+(?=\S)|(?=#|${SEQUENCE_MARK})))?(?:${AUTH_SCHEME})?(?!${AUTH_SCHEME})|(?<pair>${HEADER_PAIR})`,
  "gi",
);
// util.inspect names an instance's class before its contents: `Credentials { … }`, `Map(1) { … }`,
// `[Object: null prototype] { … }`.
const INSPECT_PREFIX =
  /(?:<ref \*\d+> )?(?:\[[\w$]+: null prototype\] |[A-Za-z_$][\w$]*(?:\(\d+\))?(?: \[[\w$ ]+\])? )?(?=[[{])/y;
const INSPECT_BUFFER = /<Buffer[^<>\r\n]*>?/y;
const WHOLE_VALUE_START = /["'`]|\\"|<Buffer/y;
const BLOCK_SCALAR = new RegExp(BLOCK_HEADER, "y");
// A space or the line's end after `#`, as comments are written, tells one from a value like `#fake`.
const COMMENT_MARK = String.raw`#(?:\s|(?:\\r)?\\n|$)`;
const COMMENT = new RegExp(`(?=${COMMENT_MARK})${LINE_COMMENT}${LINE_END}`, "y");
const COMMENT_START = new RegExp(COMMENT_MARK, "y");
// A YAML block sequence's entry or a block mapping's key, on the line below the name it belongs to.
const SEQUENCE_ENTRY = new RegExp(SEQUENCE_MARK, "y");
const MAPPING_KEY = new RegExp(String.raw`[^\s:#,[\]{}"'\\]{1,128}:(?:[ \t]|${LINE_END})`, "y");
const LINE_BEGINNING = new RegExp(String.raw`(?<=(?:${LINE_BREAK}) *)`, "y");
const YAML_PROPERTIES = new RegExp(`(?:${YAML_PROPERTY}){1,2}`, "y");
// A string quoted inside JSON text that is itself a JSON string, whose own escapes are escaped once
// more: `\\n`, `\\\"`.
const ESCAPED_STRING = /\\"(?:[^"\\\r\n]|\\\\(?:\\["\\]|[^"\\\r\n])|\\[^"\\\r\n])*\\"/y;
// A bare value runs to a space. A quote or closing bracket ends it where a word ends, as in
// `{ token: fake }`; a separator there or before another `name=`, as in `Password=fake;Database=x`; a
// backslash before a quote. Elsewhere they belong to the value. In a URL query, which cannot hold
// them, `&` and `#` always end it.
const BARE_VALUE = bareValuePattern(",;&", "");
const QUERY_VALUE = bareValuePattern(",;", "&#");
// A member's name is followed by its separator; a header list's value is not.
const MEMBER_SEPARATOR = new RegExp(`${GAP}(?:=>|:)`, "y");
const STRING_CONTINUATION = new RegExp(`${STRING_JOIN}(?=["'\`])`, "y");
const NEXT_PIECE = new RegExp(PIECE_BREAK, "y");
const PIECE_OPENED = new RegExp(String.raw`(?<=\\n${PIECE_BREAK})`, "y");
// Terminal colors can sit between a credential's name and its value, so text is matched without them.
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// util.inspect and JSON print a color code's escape character as `\x1B` or `\u001b`, which splits a
// name from its value as the code does. A printed title or link stays: its payload is shown text.
const PRINTED_COLOR = /\\(?:x1[bB]|u001[bB])\[[0-?]*[ -/]*[@-~]/g;

// A JWT sits in a run of id characters with at least two dots. Its header always encodes `{"`, and
// its payload can be as short as `{}`.
const DOTTED_RUN = /(?<![\w.-])[\w-]*(?:\.[\w-]*){2,}/g;
const JWT_HEADER = /(?:^|[-_])eyJ[\w-]{5}/;

// A quoted local part may hold escaped characters, as JSON text escapes them once more. In JSON text
// the local part may follow an escape such as `\n`, but never starts on its letter; after any other
// backslash, such as a Windows path's, it starts at once. In a URL the `@` may be encoded as `%40`.
const EMAIL_PATTERN =
  /(?:"(?:[^"\\\r\n]|\\[^\r\n]){1,64}"|\\"(?:[^"\\\r\n]|\\\\(?:\\["\\]|[^"\\\r\n])){1,64}\\"|(?:(?<=\\(?:[bfnrt]|u[0-9A-Fa-f]{4}))|(?<=\\)(?![bfnrt]|u[0-9A-Fa-f]{4})|(?<![\w.%+\\-]))[\w.%+-]{1,64})(?:@|%40)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.(?:[A-Za-z]{2,24}|[Xx][Nn]--[A-Za-z0-9-]{1,59})(?![A-Za-z0-9-])/g;

// Log and trace text is unbounded: every pattern stays linear (a bounded scheme, anchored starts).
const TEXT_REDACTIONS: ReadonlyArray<(text: string) => string> = [
  // As a URL parser does, user info runs to the authority's last `@`, quotes included, also escaped
  // as JSON text writes them.
  (text) =>
    text.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/?#\\]|\\["'])+@/gi, `$1${REDACTED}@`),
  // A PEM private key keeps its markers, so the kind of key stays readable.
  (text) =>
    text.replace(
      /(-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
      `$1${REDACTED}$2`,
    ),
  // T3's WebSocket tickets and their DPoP proofs ride in URL queries and stay valid after the request.
  (text) => text.replace(/(^|[?&"\s])(wsTicket|dpop)=[^&#"\\\s]*/g, `$1$2=${REDACTED}`),
  (text) => text.replace(CREDENTIAL_HEADER, redactHeader),
  redactCredentialFields,
  (text) => text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`),
  (text) =>
    text.replace(/(^|[^A-Za-z0-9+])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9+=])/g, `$1${REDACTED}`),
  (text) => text.replace(DOTTED_RUN, redactJwt),
  ...SECRET_TOKEN_PATTERNS.map((pattern) => (text: string) => text.replace(pattern, REDACTED)),
  (text) => text.replace(EMAIL_PATTERN, "[email]"),
];

// Every redaction's match contains one of these, so one scan clears most log and trace text. A
// credential's name is never followed by a letter there, which keeps `input_tokens` off the slow path.
// redaction.test.ts has a row per redaction; keep this in step with the list above.
const SENSITIVE_HINT = new RegExp(
  `@|%40|bearer|wsticket|dpop|private key-----|(?:${CREDENTIAL_NAME})(?![a-z])|sk-|eyJ|gh[opusr]_|github_pat_|gl(?:pat|dt|rt|ft|soat|oas|agent|ptt|cbt|imt|ffct)-|xox[a-z]-|xapp-|xwfp-|sq0(?:atp|csp)-|xai-|AIza|gsk_|hf_|AKIA|ASIA`,
  "i",
);

// A value the field's pass reads whole, such as a string, object or block scalar, after any scheme word
// or YAML anchor or tag, is left to that pass. Only its start is checked: finding its end here would
// rescan the text for every header.
function redactHeader(
  match: string,
  name: string,
  separator: string,
  scheme: string | undefined,
  digest: string | undefined,
  offset: number,
  text: string,
): string {
  const valueStart = offset + name.length + separator.length;
  HEADER_SCHEME.lastIndex = valueStart;
  const start = HEADER_SCHEME.test(text) ? HEADER_SCHEME.lastIndex : valueStart;
  YAML_PROPERTIES.lastIndex = start;
  return opensWholeValue(text, start + (YAML_PROPERTIES.exec(text)?.[0].length ?? 0))
    ? match
    : `${name}${separator}${scheme ?? digest ?? ""}${REDACTED}`;
}

// The values valueAt reads whole rather than as a word.
function opensWholeValue(text: string, start: number): boolean {
  WHOLE_VALUE_START.lastIndex = start;
  INSPECT_PREFIX.lastIndex = start;
  BLOCK_SCALAR.lastIndex = start;
  return (
    WHOLE_VALUE_START.test(text) ||
    INSPECT_PREFIX.test(text) ||
    BLOCK_SCALAR.test(text) ||
    commentAt(text, start) !== undefined
  );
}

// The whole value after a credential's name: every piece of a string, or a whole array, object,
// class instance or Buffer.
function redactCredentialFields(text: string): string {
  let result = "";
  let last = 0;
  const ends = new Map<number, number>();
  CREDENTIAL_FIELD.lastIndex = 0;
  for (let name = CREDENTIAL_FIELD.exec(text); name !== null; name = CREDENTIAL_FIELD.exec(text)) {
    const start = name.index + name[0].length;
    const inQuery = /[?&]/.test(text[name.index - 1] ?? "") && name[0].trimEnd().endsWith("=");
    const bareValue = inQuery ? QUERY_VALUE : BARE_VALUE;
    const value = credentialValue(text, name.index, start, bareValue, ends);
    if (value === undefined || (name.groups?.pair !== undefined && namesMember(text, value.end))) {
      continue;
    }
    result += `${text.slice(last, start)}${value.replacement}`;
    last = value.end;
    CREDENTIAL_FIELD.lastIndex = value.end;
  }
  return last === 0 ? text : `${result}${text.slice(last)}`;
}

function namesMember(text: string, end: number): boolean {
  MEMBER_SEPARATOR.lastIndex = end;
  return MEMBER_SEPARATOR.test(text);
}

// An anchor or tag goes with the value it marks, or is the value itself when nothing follows.
function credentialValue(
  text: string,
  key: number,
  start: number,
  bareValue: RegExp,
  ends: Map<number, number>,
): { readonly end: number; readonly replacement: string } | undefined {
  YAML_PROPERTIES.lastIndex = start;
  const properties = YAML_PROPERTIES.exec(text)?.[0];
  return (
    (properties === undefined
      ? undefined
      : valueAt(text, key, start + properties.length, bareValue, ends)) ??
    valueAt(text, key, start, bareValue, ends)
  );
}

function valueAt(
  text: string,
  key: number,
  start: number,
  bareValue: RegExp,
  ends: Map<number, number>,
): { readonly end: number; readonly replacement: string } | undefined {
  INSPECT_PREFIX.lastIndex = start;
  const prefix = INSPECT_PREFIX.exec(text)?.[0];
  if (prefix !== undefined) {
    const end = containerEnd(text, start + prefix.length, ends);
    return { end, replacement: `${prefix}${REDACTED}` };
  }
  INSPECT_BUFFER.lastIndex = start;
  if (INSPECT_BUFFER.test(text)) return { end: INSPECT_BUFFER.lastIndex, replacement: REDACTED };
  const opener = text[start];
  if (opener === '"' || opener === "'" || opener === "`") {
    let piece = stringEnd(text, start);
    STRING_CONTINUATION.lastIndex = piece.end;
    while (piece.closed && STRING_CONTINUATION.test(text)) {
      piece = stringEnd(text, STRING_CONTINUATION.lastIndex);
      STRING_CONTINUATION.lastIndex = piece.end;
    }
    const closing = piece.closed ? text[piece.end - 1] : "";
    return { end: piece.end, replacement: `${opener}${REDACTED}${closing}` };
  }
  if (text.startsWith('\\"', start)) {
    ESCAPED_STRING.lastIndex = start;
    return ESCAPED_STRING.test(text)
      ? { end: ESCAPED_STRING.lastIndex, replacement: `\\"${REDACTED}\\"` }
      : { end: text.length, replacement: `\\"${REDACTED}` };
  }
  const lines =
    blockScalarEnd(text, key, start) ??
    commentEnd(text, key, start) ??
    collectionEnd(text, key, start);
  if (lines !== undefined) return { end: lines, replacement: REDACTED };
  bareValue.lastIndex = start;
  const value = bareValue.exec(text)?.[0];
  return value === undefined ? undefined : { end: start + value.length, replacement: REDACTED };
}

function bareValuePattern(separators: string, stops: string): RegExp {
  const closers = String.raw`"'${"`"})\]}`;
  const boundary = String.raw`[\s\\${closers},;&]|$`;
  return new RegExp(
    String.raw`(?:[^\s\\${closers},;&${stops}]|[${closers}](?!${boundary})|[${separators}](?!${boundary}|[\w.-]+=)|\\(?!["']))+`,
    "y",
  );
}

function blockScalarEnd(text: string, key: number, start: number): number | undefined {
  BLOCK_SCALAR.lastIndex = start;
  const lineBreak = BLOCK_SCALAR.exec(text)?.[1];
  return lineBreak === undefined
    ? undefined
    : linesBelowEnd(text, key, BLOCK_SCALAR.lastIndex, lineBreak);
}

// A YAML comment in place of a value is the rest of its line, and the value is on the lines below,
// where a sequence may list its entries at the name's own column.
function commentEnd(text: string, key: number, start: number): number | undefined {
  const lineBreak = commentAt(text, start);
  return lineBreak === undefined
    ? undefined
    : linesBelowEnd(text, key, COMMENT.lastIndex, lineBreak, true);
}

// The line break ending the comment at `start`, if one starts there.
function commentAt(text: string, start: number): string | undefined {
  COMMENT.lastIndex = start;
  return COMMENT.exec(text)?.[1];
}

// A YAML sequence or mapping starting on a line below the name at `key` is the name's value when
// indented deeper than the name; a sequence may also list its entries at the name's own column.
function collectionEnd(text: string, key: number, start: number): number | undefined {
  LINE_BEGINNING.lastIndex = start;
  if (!LINE_BEGINNING.test(text)) return undefined;
  const sequence = sequenceEntryAt(text, start);
  MAPPING_KEY.lastIndex = start;
  if (!sequence && !MAPPING_KEY.test(text)) return undefined;
  let column = 0;
  while (text[start - column - 1] === " ") column++;
  const escaped = text[start - column - 1] !== "\n";
  const indent = keyColumn(text, key, escaped);
  if (column < indent || (column === indent && !sequence)) return undefined;
  const newline = escaped ? "\\n" : "\n";
  const next = text.indexOf(newline, start);
  if (next === -1) return text.length;
  const from = next + newline.length;
  const lineBreak = text.endsWith(escaped ? "\\r" : "\r", next)
    ? text.slice(next - (escaped ? 2 : 1), from)
    : newline;
  return linesBelowEnd(text, key, from, lineBreak, sequence);
}

function sequenceEntryAt(text: string, index: number): boolean {
  SEQUENCE_ENTRY.lastIndex = index;
  return SEQUENCE_ENTRY.test(text);
}

// Past the last line indented deeper than the credential's name at `key`, below the line that ends
// at `from` with `lineBreak`. A comment line at any depth belongs to the value too, and so does a
// blank line between them, and with `entries`, a sequence entry at the name's own column.
function linesBelowEnd(
  text: string,
  key: number,
  from: number,
  lineBreak: string,
  entries = false,
): number {
  let end = from - lineBreak.length;
  if (lineBreak === "") return end;
  const escaped = lineBreak.startsWith("\\");
  const newline = escaped ? "\\n" : "\n";
  const indent = keyColumn(text, key, escaped);
  for (let index = lineAfter(text, from, escaped); index < text.length;) {
    const next = text.indexOf(newline, index);
    let lineEnd = next === -1 ? text.length : next;
    if (text.endsWith(escaped ? "\\r" : "\r", lineEnd)) lineEnd -= escaped ? 2 : 1;
    const spaces = leadingSpaces(text, index);
    const content = index + spaces;
    COMMENT_START.lastIndex = content;
    if (content < lineEnd) {
      const entry = entries && spaces === indent && sequenceEntryAt(text, content);
      if (spaces <= indent && !entry && !COMMENT_START.test(text)) break;
      end = lineEnd;
    }
    index = next === -1 ? text.length : lineAfter(text, next + newline.length, escaped);
  }
  return end;
}

// Past the break between a split string's pieces at `index`, where printed text's next line begins.
function lineAfter(text: string, index: number, escaped: boolean): number {
  if (!escaped) return index;
  NEXT_PIECE.lastIndex = index;
  return NEXT_PIECE.test(text) ? NEXT_PIECE.lastIndex : index;
}

// The column of the name at `key`, counting a list entry's `- `, as YAML indents the entry's block
// deeper still. A name after other text on its line, as in JSON or a printed object, has no column
// of its own, so its block takes every indented line.
function keyColumn(text: string, key: number, escaped: boolean): number {
  const lineStart = lineStartBefore(text, key, escaped);
  let index = lineStart + leadingSpaces(text, lineStart);
  while (text.startsWith("- ", index)) index += 1 + leadingSpaces(text, index + 1);
  const quoted = text[index] === '"' || text[index] === "'";
  return index + (quoted ? 1 : 0) === key ? index - lineStart : 0;
}

// After the line break before `index`; in printed text an escaped `\n` breaks a line too, and a
// split string's piece starts its line after its quote.
function lineStartBefore(text: string, index: number, escaped: boolean): number {
  for (let start = index; start > 0; start--) {
    if (escaped && text.startsWith("\\n", start - 2)) return start;
    if (text[start - 1] === "\n") return escaped ? pieceStart(text, start) : start;
  }
  return 0;
}

function pieceStart(text: string, lineStart: number): number {
  const content = lineStart + leadingSpaces(text, lineStart) + 1;
  PIECE_OPENED.lastIndex = content;
  return PIECE_OPENED.test(text) ? content : lineStart;
}

function leadingSpaces(text: string, start: number): number {
  let index = start;
  while (text[index] === " ") index++;
  return index - start;
}

// Past the quote that closes the string opening at `start`. A doubled quote stays inside, as YAML's
// single-quoted strings, SQL and CSV write one, even after a backslash, which YAML keeps as written.
// An unclosed string, like any malformed value, runs to the end of the text.
function stringEnd(
  text: string,
  start: number,
): { readonly end: number; readonly closed: boolean } {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    if (text[index] === quote && text[index + 1] === quote) index++;
    else if (char === quote) return { end: index + 1, closed: true };
  }
  return { end: text.length, closed: false };
}

// Past the bracket that closes the array or object opening at `start`. A string within, closed or
// not, is skipped whole. A malformed value, unclosed or closed by the other kind of bracket, runs
// to the end of the text rather than ending early. `ends` keeps the end of each container closed on
// the way, so a value nested in one already read, such as a Map key, is not read again.
function containerEnd(text: string, start: number, ends: Map<number, number>): number {
  const opened: Array<number> = [];
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
    } else if (char === '"' || char === "'" || char === "`") {
      index = stringEnd(text, index).end - 1;
    } else if (char === "[" || char === "{") {
      const known = ends.get(index);
      if (known === undefined) opened.push(index);
      else if (opened.length === 0) return known;
      else index = known - 1;
    } else if (char === "]" || char === "}") {
      const open = opened.pop();
      if (open === undefined || text[open] !== (char === "]" ? "[" : "{")) return text.length;
      ends.set(open, index + 1);
      if (opened.length === 0) return index + 1;
    }
  }
  return text.length;
}

// Segment by segment, so a long run costs one pass.
function redactJwt(run: string): string {
  const segments = run.split(".");
  for (let index = 0; index + 2 < segments.length; index++) {
    const segment = segments[index] ?? "";
    const header = JWT_HEADER.exec(segment);
    if (header === null || segments[index + 1] === "") continue;
    const start = header.index + (header[0].startsWith("e") ? 0 : 1);
    return [...segments.slice(0, index), `${segment.slice(0, start)}${REDACTED}`].join(".");
  }
  return run;
}

/** Removes credentials (URL user info, T3 connection tickets, auth headers, API tokens, values named for one) and e-mail addresses from text. */
export function redactSensitiveText(text: string): string {
  const plain = plainText(text);
  // A terminal hides an OSC sequence's payload, such as a hyperlink's URL, which is never checked,
  // so text holding one comes back without escapes.
  const unchanged = text.includes("\u001b]") ? plain : text;
  if (!SENSITIVE_HINT.test(plain)) return unchanged;
  let result = plain;
  for (const redact of TEXT_REDACTIONS) {
    result = redact(result);
  }
  return result === plain ? unchanged : result;
}

/** `text` without terminal color and title escapes. */
export function stripTerminalEscapes(text: string): string {
  return text.includes("\u001b") ? text.replace(ANSI_ESCAPE, "") : text;
}

/** JSON text of a value with each string and member name redacted on its own, so no redaction can break the JSON. */
export function stringifyRedacted(value: unknown): string {
  const text = JSON.stringify(value);
  return mayHoldSensitiveJson(text) ? JSON.stringify(value, redactJsonField) : text;
}

/**
 * A log message's parts, each one after a part naming a credential masked: a header name, as in
 * `Effect.logWarning("Cookie", value)`, or text ending in a name and its separator, such as `"token:"`.
 * Loggers print and export the parts apart, so redacting their text cannot tell what a part holds.
 */
export function redactMessageParts(message: unknown): unknown {
  if (!Array.isArray(message)) return message;
  return maskNamedValues(message, namesCredentialPart, maskCredential) ?? message;
}

function namesCredentialPart(part: unknown): boolean {
  if (typeof part !== "string") return false;
  const text = plainText(part).trimEnd();
  const separator = text.endsWith("=>") ? 2 : text.endsWith(":") || text.endsWith("=") ? 1 : 0;
  return (
    HEADER_KEY.test(text) ||
    (separator > 0 && CREDENTIAL_KEY.test(text.slice(0, -separator).trimEnd()))
  );
}

// Text as a terminal shows it: color codes, printed or not, can split a name from its value.
function plainText(text: string): string {
  return stripTerminalEscapes(text).replace(PRINTED_COLOR, "");
}

/** `json` redacted as {@link stringifyRedacted} redacts a value. */
export function redactJsonText(json: string): string {
  return mayHoldSensitiveJson(json) ? JSON.stringify(JSON.parse(json), redactJsonField) : json;
}

// JSON text escapes a terminal color code, which can split a credential's name until it is removed.
function mayHoldSensitiveJson(json: string): boolean {
  return SENSITIVE_HINT.test(json) || /\\u001b/i.test(json);
}

function redactJsonField(key: string, value: unknown): unknown {
  if (namesCredential(key, value)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return maskNamedValues(value, namesHeader, maskCredential) ?? value;
  return isObject(value) ? redactMemberNames(value) : value;
}

function namesCredential(key: string, value: unknown): boolean {
  return CREDENTIAL_KEY.test(key) && holdsCredential(value);
}

// A number can be a PIN or a password read from YAML; only a flag such as `hasSecret` stays.
function holdsCredential(value: unknown): boolean {
  return value !== null && typeof value !== "boolean";
}

function maskCredential(value: unknown): unknown {
  return holdsCredential(value) ? REDACTED : undefined;
}

// A header list puts a header's value after its name, as Node's flat `rawHeaders` and
// `[name, value]` pairs list them.
function namesHeader(item: unknown): boolean {
  return typeof item === "string" && HEADER_KEY.test(item);
}

// A copy of `items` with `mask`'s replacement for each item after one that `names` a credential;
// undefined when none is replaced.
function maskNamedValues(
  items: ReadonlyArray<unknown>,
  names: (item: unknown) => boolean,
  mask: (item: unknown) => unknown,
): Array<unknown> | undefined {
  let masked: Array<unknown> | undefined;
  for (let index = 1; index < items.length; index++) {
    const replacement = names(items[index - 1]) ? mask(items[index]) : undefined;
    if (replacement === undefined) continue;
    masked ??= [...items];
    masked[index++] = replacement;
  }
  return masked;
}

// A replacer can only change values, so an object whose member names need redacting is copied. Its
// values are masked here by their original names, which the replacer no longer sees.
function redactMemberNames(value: object): object {
  const names = Object.keys(value);
  if (names.every((name) => redactSensitiveText(name) === name)) return value;
  return Object.fromEntries(
    names.map((name) => {
      const member: unknown = (value as Record<string, unknown>)[name];
      return [redactSensitiveText(name), namesCredential(name, member) ? REDACTED : member];
    }),
  );
}

/** `serialization` redacting every OTLP export first, so logs, spans, events, links and metrics leave clean. */
export const layerRedactedOtlpSerialization = (
  serialization: Layer.Layer<OtlpSerialization.OtlpSerialization>,
) =>
  Layer.effect(
    OtlpSerialization.OtlpSerialization,
    Effect.gen(function* () {
      const base = yield* OtlpSerialization.OtlpSerialization;
      return {
        traces: (data) => base.traces(redactOtlpPayload(data)),
        metrics: (data) => base.metrics(redactOtlpPayload(data)),
        logs: (data) => base.logs(redactOtlpPayload(data)),
      };
    }),
  ).pipe(Layer.provide(serialization));

/** An OTLP export with each string redacted and each attribute named for a credential masked. */
export function redactOtlpPayload<A>(payload: A): A {
  return redactOtlpNode(payload) as A;
}

function redactOtlpNode(node: unknown): unknown {
  if (typeof node === "string") return redactSensitiveText(node);
  if (Array.isArray(node)) {
    // An array attribute's values are AnyValues too, so a header list's names are `{ stringValue }`.
    let items = maskNamedValues(
      node,
      (item) => isObject(item) && namesHeader((item as { stringValue?: unknown }).stringValue),
      (item) => (holdsOtlpCredential(item) ? { stringValue: REDACTED } : undefined),
    );
    const listed = items ?? node;
    for (let index = 0; index < listed.length; index++) {
      const item: unknown = listed[index];
      const redacted = redactOtlpNode(item);
      if (redacted === item) continue;
      items ??= [...node];
      items[index] = redacted;
    }
    return items ?? node;
  }
  if (!isObject(node) || Object.getPrototypeOf(node) !== Object.prototype) return node;
  const record = node as Record<string, unknown>;
  // An attribute is `{ key, value }`, its value an AnyValue such as `{ stringValue }`.
  const masked =
    typeof record.key === "string" &&
    CREDENTIAL_KEY.test(record.key) &&
    holdsOtlpCredential(record.value);
  let fields: Record<string, unknown> | undefined;
  for (const [name, field] of Object.entries(record)) {
    const redacted = masked && name === "value" ? { stringValue: REDACTED } : redactOtlpNode(field);
    if (redacted === field) continue;
    fields ??= { ...record };
    fields[name] = redacted;
  }
  return fields ?? node;
}

function holdsOtlpCredential(value: unknown): boolean {
  return isObject(value) && !("boolValue" in value);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
