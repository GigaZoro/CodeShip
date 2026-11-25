import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

const argv = process.argv.slice(2);
const args = argv.join(" ");

function fail(message, code) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

if (valueOf("--permission-mode") !== "dontAsk") {
  fail("text generation must deny permission prompts", 12);
}
const investigation = process.env.T3_FAKE_CLAUDE_INVESTIGATION === "1";
const expectedTools = investigation ? "Read,Grep,Glob,Bash" : "";
if (valueOf("--tools") !== expectedTools) {
  fail("text generation received an unexpected tool set", 6);
}
if (
  investigation &&
  valueOf("--allowedTools") !== "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)"
) {
  fail("investigation tools must be limited to read-only operations", 17);
}
if (investigation && valueOf("--disallowedTools") !== "Bash(git * --output*),Bash(git * -o *)") {
  fail("investigation must deny git options that write files", 15);
}
const schemaJson = valueOf("--json-schema");
const schema = schemaJson === undefined ? undefined : JSON.parse(schemaJson);
if (schema?.type !== "object") {
  fail("text generation must request structured output", 14);
}
const schemaProperty = process.env.T3_FAKE_CLAUDE_SCHEMA_PROPERTY;
if (schemaProperty && !Object.hasOwn(schema.properties ?? {}, schemaProperty)) {
  fail(`the output schema lacks '${schemaProperty}'`, 18);
}
if (argv.includes("--dangerously-skip-permissions")) {
  fail("text generation must not bypass permissions", 7);
}
if (!argv.includes("--disable-slash-commands")) {
  fail("text generation must disable skills", 8);
}
if (!argv.includes("--strict-mcp-config")) {
  fail("text generation must not load configured MCP servers", 9);
}
const unsupportedOptions = JSON.parse(process.env.T3_FAKE_CLAUDE_UNSUPPORTED_OPTIONS ?? "[]");
for (const option of unsupportedOptions) {
  if (argv.includes(option)) {
    fail(`error: unknown option '${option}'`, 1);
  }
}
for (const option of ["--safe-mode", "--no-session-persistence"]) {
  if (!unsupportedOptions.includes(option) && !argv.includes(option)) {
    fail(`text generation must pass '${option}' when supported`, 16);
  }
}
const settingsJson = valueOf("--settings");
if (settingsJson === undefined || JSON.parse(settingsJson).disableAllHooks !== true) {
  fail("text generation must disable hooks", 10);
}
const settingsMustEqual = process.env.T3_FAKE_CLAUDE_SETTINGS_MUST_EQUAL;
if (settingsMustEqual) {
  const settingsValues = argv.flatMap((arg, index) =>
    arg === "--settings" ? [argv[index + 1]] : [],
  );
  const received = settingsValues.map((value) => JSON.parse(value));
  if (
    received.length !== 1 ||
    !NodeUtil.isDeepStrictEqual(received[0], JSON.parse(settingsMustEqual))
  ) {
    fail("--settings was " + settingsValues.join(" --settings "), 13);
  }
}
const cwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
if (cwdMustNotBe && NodeFS.realpathSync(process.cwd()) === NodeFS.realpathSync(cwdMustNotBe)) {
  fail("text generation ran in the project directory", 11);
}

let stdinContent = "";
if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  stdinContent = Buffer.concat(chunks).toString("utf8");
}

const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
if (argsMustContain && !args.includes(argsMustContain)) {
  fail("args missing expected content", 2);
}

const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
if (argsMustNotContain && args.includes(argsMustNotContain)) {
  fail("args contained forbidden content", 3);
}

const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {
  fail("stdin missing expected content", 4);
}

const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {
  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);
}

const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;
if (stderrText) {
  process.stderr.write(stderrText + "\n");
}

process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");
process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);
