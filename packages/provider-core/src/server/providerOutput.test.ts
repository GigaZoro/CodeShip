import { describe, expect, it } from "vite-plus/test";

import { commandFailureReason, redactProviderOutput } from "./providerOutput.ts";

describe("redactProviderOutput", () => {
  it("redacts home paths, pairing URLs, and tokens from CLI output", () => {
    const excerpt = redactProviderOutput(
      [
        "Invalid project config at /Users/ada/.cursor/cli.json",
        "Authorization: Bearer secret-token-value",
        "Sign in: https://accounts.google.com/o/oauth2/v2/auth?state=oauth-state-value",
        "Visit http://localhost:5733/pair#token=ABCDEF for pairing",
        "key=sk-abcdefghijklmnopqrstuv",
        "Signed in as ada.lovelace+work@example.co.uk",
      ].join("\n"),
      "/home/server",
      { HOME: "/Users/ada" },
    );

    expect(excerpt).toContain("Invalid project config at ~/.cursor/cli.json");
    expect(excerpt).toContain("Signed in as [email]");
    expect(excerpt).toContain("Bearer [redacted]");
    expect(excerpt).toContain("[pairing-url]");
    expect(excerpt).toContain("[redacted]");
    expect(excerpt).not.toContain("secret-token-value");
    expect(excerpt).not.toContain("ABCDEF");
    expect(excerpt).toContain("[sign-in-url]");
    expect(excerpt).not.toContain("oauth-state-value");
    expect(excerpt).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("redacts hyphenated OpenAI project keys and header credentials", () => {
    const excerpt = redactProviderOutput(
      [
        "openai=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
        "svc=sk-svcacct-abcdefghijklmnopqrstuvwxyz012345",
        "anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
        "Authorization: Basic dXNlcjpwYXNz",
        "x-api-key: ant-api-key-value",
      ].join("\n"),
      "/Users/ada",
      {},
    );

    expect(excerpt).toContain("[redacted]");
    expect(excerpt).toContain("Authorization: Basic [redacted]");
    expect(excerpt).toContain("x-api-key: [redacted]");
    expect(excerpt).not.toContain("sk-proj-");
    expect(excerpt).not.toContain("sk-svcacct-");
    expect(excerpt).not.toContain("sk-ant-api03-");
    expect(excerpt).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(excerpt).not.toContain("dXNlcjpwYXNz");
    expect(excerpt).not.toContain("ant-api-key-value");
  });

  it("redacts the whole key when its body contains underscores", () => {
    const excerpt = redactProviderOutput(
      [
        "anthropic=sk-ant-api03-AbCdEf_GhIjKlMnOpQr-StUvWx_yz0123456789-AA",
        "openai=sk-proj-AbCdEfGhIj_KlMnOpQrStUv-WxYz_0123456789",
      ].join("\n"),
      "/Users/ada",
      {},
    );

    expect(excerpt).toBe("anthropic=[redacted]\nopenai=[redacted]");
  });

  it.each([
    {
      kind: "a JWT",
      line: "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      expected: "session [redacted]",
    },
    {
      kind: "an unsigned JWT with an empty payload",
      line: "unsigned eyJhbGciOiJub25lIn0.e30. rejected",
      expected: "unsigned [redacted] rejected",
    },
    {
      kind: "an AWS access key",
      line: "key AKIAIOSFODNN7EXAMPLE rejected",
      expected: "key [redacted] rejected",
    },
    {
      kind: "a GitHub token",
      line: "token ghs_abcdefghijklmnopqrstuvwxyz0123",
      expected: "token [redacted]",
    },
    {
      kind: "a fine-grained GitHub token",
      line: "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      expected: "[redacted]",
    },
    { kind: "a GitLab token", line: "glpat-abcdefghijklmnopqrstu", expected: "[redacted]" },
    { kind: "a Slack token", line: "xoxb-1234567890-abcdefghij", expected: "[redacted]" },
    {
      kind: "a Slack webhook",
      line: "posting to https://hooks.slack.com/services/T000/B000/XXXX failed",
      expected: "posting to [redacted] failed",
    },
    {
      kind: "a Google API key",
      line: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
      expected: "[redacted]",
    },
    { kind: "an xAI key", line: "xai-abcdefghijklmnopqrstuvwxyz", expected: "[redacted]" },
    {
      kind: "URL credentials",
      line: "fetch https://deploy:hunter2@registry.example.com/pkg failed",
      expected: "fetch https://[redacted]@registry.example.com/pkg failed",
    },
    {
      kind: "a URL user without a password",
      line: "connect https://opaque-hunter2@localhost:8080/x",
      expected: "connect https://[redacted]@localhost:8080/x",
    },
    {
      kind: "an OpenAI sign-in link",
      line: "open https://auth.openai.com/oauth/authorize?client_id=app&state=hunter2 to sign in",
      expected: "open [sign-in-url] to sign in",
    },
    {
      kind: "a Claude sign-in link",
      line: "https://claude.ai/oauth/authorize?code=true&state=hunter2",
      expected: "[sign-in-url]",
    },
    {
      kind: "a URL query",
      line: "GET https://api.example.com/v1/models?api_key=hunter2 returned 401",
      expected: "GET https://api.example.com/v1/models?[redacted] returned 401",
    },
    {
      kind: "a secret assignment",
      line: 'config password = "hunter2" is weak',
      expected: "config password = [redacted] is weak",
    },
    {
      kind: "a quoted secret with spaces",
      line: 'password="hunter2 and more" rejected',
      expected: "password=[redacted] rejected",
    },
    {
      kind: "an environment token",
      line: "ANTHROPIC_AUTH_TOKEN=hunter2",
      expected: "ANTHROPIC_AUTH_TOKEN=[redacted]",
    },
    {
      kind: "an environment secret key",
      line: "AWS_SECRET_ACCESS_KEY: hunter2",
      expected: "AWS_SECRET_ACCESS_KEY: [redacted]",
    },
    {
      kind: "a JSON secret",
      line: 'status=500 body={"token":"hunter2"}',
      expected: 'status=500 body={"token":[redacted]}',
    },
    {
      kind: "an email with a quoted local part",
      line: 'signed in as "ada lovelace"@example.com',
      expected: "signed in as [email]",
    },
  ])("redacts $kind", ({ line, expected }) => {
    expect(redactProviderOutput(line, "/Users/ada", {})).toBe(expected);
  });

  it("redacts a Windows home in any casing, separator or JSON escaping", () => {
    const excerpt = redactProviderOutput(
      [
        "c:/users/ada/.claude/settings.json",
        String.raw`{"path":"C:\\Users\\Ada\\.claude"}`,
        String.raw`C:\Users\ADA\AppData`,
        String.raw`C:\Users\Adam`,
      ].join("\n"),
      String.raw`C:\Users\Ada`,
      {},
    );

    expect(excerpt).toBe(
      [
        "~/.claude/settings.json",
        String.raw`{"path":"~\\.claude"}`,
        String.raw`~\AppData`,
        String.raw`C:\Users\Adam`,
      ].join("\n"),
    );
  });

  it("strips terminal colour codes", () => {
    expect(redactProviderOutput("\u001b[31mError:\u001b[0m bad config", "/Users/ada", {})).toBe(
      "Error: bad config",
    );
  });
});

describe("commandFailureReason", () => {
  it.each([
    {
      scenario: "the first stderr line, redacted",
      output: {
        stdout: "",
        stderr:
          "\nError: config at /Users/ada/.grok/config.json is invalid\n    at load (cli.js:1:1)\n",
      },
      expected: "Error: config at ~/.grok/config.json is invalid",
    },
    {
      scenario: "stdout when stderr is empty",
      output: { stdout: "Not logged in as ada@example.com\n", stderr: "  \n" },
      expected: "Not logged in as [email]",
    },
    {
      scenario: "the error line of a Node crash, not its source preamble",
      output: {
        stdout: "",
        stderr: [
          "/Users/ada/.npm/grok/cli.js:12",
          '    throw new Error("missing GROK_HOME");',
          "    ^",
          "",
          "Error: missing GROK_HOME",
          "    at Object.<anonymous> (/Users/ada/.npm/grok/cli.js:12:11)",
        ].join("\n"),
      },
      expected: "Error: missing GROK_HOME",
    },
    {
      scenario: "the error line of a Bun crash, not its source preamble",
      output: {
        stdout: "",
        stderr: '1 | throw new TypeError("bad flag")\n          ^\nTypeError: bad flag\n',
      },
      expected: "TypeError: bad flag",
    },
    {
      scenario: "the error after a crash source line that mentions Error",
      output: {
        stdout: "",
        stderr: "[eval]:1\nError.captureStackTrace(42)\n      ^\n\nTypeError: invalid_argument\n",
      },
      expected: "TypeError: invalid_argument",
    },
    {
      scenario: "a coded error after a crash in a folder with spaces",
      output: {
        stdout: "",
        stderr: "/Users/ada/My Projects/cli.js:3\n  run()\n  ^\n\nError [ERR_BAD]: boom\n",
      },
      expected: "Error [ERR_BAD]: boom",
    },
    {
      scenario: "a first line that only ends with a port, not a crash",
      output: { stdout: "", stderr: "host:8080\nError: later context\n" },
      expected: "host:8080",
    },
    {
      scenario: "a long line capped",
      output: { stdout: "", stderr: "x".repeat(500) },
      expected: `${"x".repeat(239)}…`,
    },
    { scenario: "nothing when the CLI printed nothing", output: { stdout: "", stderr: "" } },
  ])("returns $scenario", ({ output, expected }) => {
    expect(commandFailureReason(output, "/Users/ada", {})).toBe(expected);
  });
});
