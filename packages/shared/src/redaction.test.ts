import { assert, describe, it } from "@effect/vitest";

import {
  redactJsonText,
  redactMessageParts,
  redactOtlpPayload,
  redactSensitiveText,
  stringifyRedacted,
} from "./redaction.ts";

describe("redactSensitiveText", () => {
  // One row per redaction, so a pattern the prefilter misses fails here.
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["https://user:pass@example.com/x", "https://[redacted]@example.com/x"],
    [
      "/ws?wsTicket=ticket-1&dpop=proof-1&clientSurface=web",
      "/ws?wsTicket=[redacted]&dpop=[redacted]&clientSurface=web",
    ],
    ["Authorization: Bearer abc.DEF-1_2~3+4/5=", "Authorization: Bearer [redacted]"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [redacted]"],
    ["x-api-key: key-value-1", "x-api-key: [redacted]"],
    ["x-api-key: a;b", "x-api-key: [redacted]"],
    ['Authorization: Digest username="u", response="6629fae4"', "Authorization: Digest [redacted]"],
    [
      "Authorization: Bearer\r\n fake-opaque\r\nHost: x",
      "Authorization: Bearer\r\n [redacted]\r\nHost: x",
    ],
    ["Authorization: Digest\n username=fake", "Authorization: Digest\n [redacted]"],
    [
      'Authorization: Digest username="fake-user",\r\n response="fake-opaque"\r\nHost: x',
      "Authorization: Digest [redacted]\r\nHost: x",
    ],
    ["Cookie: a=fake;\n\tb=fake-opaque\nHost: x", "Cookie: [redacted]\nHost: x"],
    ["token: Basic\n\tfake-opaque", "token: Basic\n\t[redacted]"],
    ["Cookie: session=abc; theme=dark", "Cookie: [redacted]"],
    [
      '{"x-api-key":"key-1","authorization":"Basic dXNlcjpwYXNz"}',
      '{"x-api-key":"[redacted]","authorization":"[redacted]"}',
    ],
    ['{"password":"ab\\"cd","tokens":3}', '{"password":"[redacted]","tokens":3}'],
    [
      "Session { desktopBootstrapToken: 'bootstrap-1', inputTokens: 5 }",
      "Session { desktopBootstrapToken: '[redacted]', inputTokens: 5 }",
    ],
    ["GET /cb?access_token=abc&state=x", "GET /cb?access_token=[redacted]&state=x"],
    ["Server=db;Password=hunter2;Database=x", "Server=db;Password=[redacted];Database=x"],
    ["max_tokens=4096 token_type: bearer", "max_tokens=4096 token_type: bearer"],
    ["retry with Bearer abc.DEF-1_2~3+4/5= later", "retry with Bearer [redacted] later"],
    ["key AKIAABCDEFGHIJKLMNOP end", "key [redacted] end"],
    ["key sk-abcdefghijkl end", "key [redacted] end"],
    ["jwt eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl end", "jwt [redacted] end"],
    ["session-eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl; Path=/", "session-[redacted]; Path=/"],
    [`${"a".repeat(64)}-eyJhbGciOi.eyJzdWIi.c2ln end`, `${"a".repeat(64)}-[redacted] end`],
    ["gh ghp_abcdefghijklmnopqrstuvwxyz end", "gh [redacted] end"],
    ["pat github_pat_abcdefghijklmnopqrstuvwxyz end", "pat [redacted] end"],
    ["gl glpat-abcdefghijklmnopqrstuvwxyz end", "gl [redacted] end"],
    ["slack xoxb-1234567890-abc end", "slack [redacted] end"],
    ["square sq0atp-abcdefghijklmnopqrstuvwxyz end", "square [redacted] end"],
    ["xai xai-abcdefghijklmnopqrstuvwxyz end", "xai [redacted] end"],
    ["google AIzaSyabcdefghijklmnopqrstuvwxyz0123456 end", "google [redacted] end"],
    ["hf hf_abcdefghijklmnopqrstuvwxyz end", "hf [redacted] end"],
    ["Signed in as a.b+c@mail.example.co.uk. Sign in", "Signed in as [email]. Sign in"],
    ['signed in as "john doe"@example.com', "signed in as [email]"],
    ['to "last, first"@example.com', "to [email]"],
    ["signed in as fake-user@example.xn--p1ai", "signed in as [email]"],
    ["git@github.com:org/repo", "[email]:org/repo"],
    [
      "GET /authorize?login_hint=a.b%2Bc%40example.com&x=1",
      "GET /authorize?login_hint=[email]&x=1",
    ],
    [
      "node_modules/.pnpm/effect@4.0.5/node_modules @effect/vitest@1.0.0 pkg@1.2.3-beta.1",
      "node_modules/.pnpm/effect@4.0.5/node_modules @effect/vitest@1.0.0 pkg@1.2.3-beta.1",
    ],
    ["admin@localhost", "admin@localhost"],
    ["C:\\Users\\user@example.com\\file.ts", "C:\\Users\\[email]\\file.ts"],
    ["{ token: [ 'fake-opaque' ] }", "{ token: [redacted] }"],
    ["{ 'set-cookie': [ 'sid=fake; Path=/' ], ok: 1 }", "{ 'set-cookie': [redacted], ok: 1 }"],
    [
      "{\n  credentials: {\n    value: 'fake-opaque',\n    nested: { a: [1, 2] }\n  },\n  ok: true\n}",
      "{\n  credentials: [redacted],\n  ok: true\n}",
    ],
    ['{"credentials":{"value":"fake-opaque"}}', '{"credentials":[redacted]}'],
    ['{ token: `it\'s "fake"` }', "{ token: `[redacted]` }"],
    [
      "{ privateKey: '-----BEGIN-----\\n' +\n    'fake-body\\n' +\n    '-----END-----' }",
      "{ privateKey: '[redacted]' }",
    ],
    ["token: [ 'a]b' ], x: 1", "token: [redacted], x: 1"],
    ["token: [ 'fake", "token: [redacted]"],
    ["credentials: ['prefix]fake-tail", "credentials: [redacted]"],
    ["credentials: [unclosed}fake-tail", "credentials: [redacted]"],
    ["credentials: [oops}prefix]fake-tail", "credentials: [redacted]"],
    ["password: #fake-value", "password: [redacted]"],
    ["password: \\fake-value", "password: [redacted]"],
    ["token:\nfake-value", "token:\n[redacted]"],
    [
      "password: fake#tail, secret: fake\\tail, token: fake'tail next",
      "password: [redacted], secret: [redacted], token: [redacted] next",
    ],
    [
      "?token=fake-opaque#frag 'token=fake-opaque', x",
      "?token=[redacted]#frag 'token=[redacted]', x",
    ],
    ["password: ab;cd,ef&gh next", "password: [redacted] next"],
    ["refresh_token=fake-opaque&client_id=x", "refresh_token=[redacted]&client_id=x"],
    ["credentials: `fake\nfake-tail", "credentials: `[redacted]"],
    ['password: "fake\nfake-tail', 'password: "[redacted]'],
    ['{\\"password\\":\\"fake\\\\nfake-tail\\"} ok', '{\\"password\\":\\"[redacted]\\"} ok'],
    ['\\"password\\":\\"fake\nfake-tail', '\\"password\\":\\"[redacted]'],
    ["{ secret: <Buffer 66 61 6b 65", "{ secret: [redacted]"],
    ["https://fake-user:fake-pass'w@rd@example.test/pkg", "https://[redacted]@example.test/pkg"],
    ['https://fake-user:fake-pa"ss@example.test/pkg', "https://[redacted]@example.test/pkg"],
    [
      "password: |\n  fake-opaque\n\n  fake-tail\nstatus: denied",
      "password: [redacted]\nstatus: denied",
    ],
    [
      "- privateKey: >-2 # pem\r\n    fake-opaque\r\n  user: x",
      "- privateKey: [redacted]\r\n  user: x",
    ],
    [
      '"note":"password: |\\n  fake-opaque\\nstatus: denied"',
      '"note":"password: [redacted]\\nstatus: denied"',
    ],
    ["token: |", "token: [redacted]"],
    ["Cookie: |\n  session=fake-opaque\nHost: x", "Cookie: [redacted]\nHost: x"],
    ["password: &pw |\n  fake-opaque\nstatus: denied", "password: [redacted]\nstatus: denied"],
    ['password: !!str "fake-opaque", next', 'password: "[redacted]", next'],
    ["secret: &a !!str fake-opaque next", "secret: [redacted] next"],
    ["password:\n  |\n  fake-opaque\nstatus: denied", "password:\n  [redacted]\nstatus: denied"],
    ["- token:\n    !!str |\n    fake-opaque\n  user: x", "- token:\n    [redacted]\n  user: x"],
    [
      '{"note":"password:\\n  |\\n  fake-opaque\\nstatus: denied"}',
      '{"note":"password:\\n  [redacted]\\nstatus: denied"}',
    ],
    ['"note":"password:\\n  fake-opaque and more"', '"note":"password:\\n  [redacted] and more"'],
    [
      "{\n  note: 'password:\\n' +\n    '  fake-opaque\\n' +\n    'status: denied'\n}",
      "{\n  note: 'password:\\n' +\n    '  [redacted]' +\n    'status: denied'\n}",
    ],
    [
      "{\n  note: 'password: |\\n' +\n    '  fake-opaque\\n' +\n    'status: denied'\n}",
      "{\n  note: 'password: [redacted]\\n' +\n    'status: denied'\n}",
    ],
    [
      "{\n  a: 'x\\n          y',\n  b: 'password: |\\n  fake-opaque\\n'\n}",
      "{\n  a: 'x\\n          y',\n  b: 'password: [redacted]\\n'\n}",
    ],
    [
      "    Error in config password: |\n  fake-opaque\nnext",
      "    Error in config password: [redacted]\nnext",
    ],
    ["{ prompt: 'Enter token:\\n', b: 'xyz' }", "{ prompt: 'Enter token:[redacted]', b: 'xyz' }"],
    [
      "password:\n\n  |\n  fake-opaque\nstatus: denied",
      "password:\n\n  [redacted]\nstatus: denied",
    ],
    [
      '"note":"password:\\n\\n  |\\n  fake-opaque\\nstatus: denied"',
      '"note":"password:\\n\\n  [redacted]\\nstatus: denied"',
    ],
    ["password:\n\nNext paragraph", "password:\n\nNext paragraph"],
    [
      "password: # set below\n  |\n  fake-opaque\nstatus: denied",
      "password: [redacted]\nstatus: denied",
    ],
    [
      "password:\n  # set below\n  fake-opaque\nstatus: denied",
      "password:\n  [redacted]\nstatus: denied",
    ],
    ["Cookie: # session\n  |\n  a=fake-opaque\nHost: x", "Cookie: [redacted]\nHost: x"],
    [
      "Error: invalid password: #fake-opaque\n    at run (x.js:1:1)",
      "Error: invalid password: [redacted]\n    at run (x.js:1:1)",
    ],
    [
      "password: # database password\n# supplied by the deployment\n  fake-opaque\nstatus: denied",
      "password: [redacted]\nstatus: denied",
    ],
    [
      "{ note: 'password:\\n# comment\\n  fake-opaque\\nstatus: denied' }",
      "{ note: 'password:\\n[redacted]\\nstatus: denied' }",
    ],
    [
      "set-cookie:\n  - session=fake-opaque; Path=/; HttpOnly\n  - id=fake-opaque\nstatus: denied",
      "set-cookie:\n  [redacted]\nstatus: denied",
    ],
    [
      "set-cookie:\n- a=fake-opaque\n- b=fake-opaque\nstatus: denied",
      "set-cookie:\n[redacted]\nstatus: denied",
    ],
    [
      "set-cookie:\r\n  - a=fake-opaque\r\n  - b=fake-opaque\r\nstatus: denied",
      "set-cookie:\r\n  [redacted]\r\nstatus: denied",
    ],
    [
      "credentials:\n  user: fake-user\n  key:\n    fake-opaque\nstatus: denied",
      "credentials:\n  [redacted]\nstatus: denied",
    ],
    ["- token:\n  - fake-opaque\n- name: x", "- token:\n  [redacted]\n- name: x"],
    ["credentials:\nvalue: x", "credentials:\n[redacted] x"],
    [
      '{"note":"password:\\n  - fake-opaque\\n  - fake-opaque\\nstatus: denied"}',
      '{"note":"password:\\n  [redacted]\\nstatus: denied"}',
    ],
    [
      '{"note":"password:\\n- fake-opaque\\n- fake-opaque\\nstatus: denied"}',
      '{"note":"password:\\n[redacted]\\nstatus: denied"}',
    ],
    [
      "set-cookie: # response cookies\n- session=fake-opaque\n- csrf=fake-opaque\nstatus: denied",
      "set-cookie: [redacted]\nstatus: denied",
    ],
    [
      "password:\n# set below\n- fake-opaque\nstatus: denied",
      "password:\n[redacted]\nstatus: denied",
    ],
    ["- token: # c\n- next: x", "- token: [redacted]\n- next: x"],
    [
      "{\n  note: 'set-cookie: # response cookies\\n' +\n    '- session=fake-opaque\\n' +\n    '- csrf=fake-opaque\\n' +\n    'status: denied'\n}",
      "{\n  note: 'set-cookie: [redacted]\\n' +\n    'status: denied'\n}",
    ],
    [
      '{"message":"credentials:\\n-\\n  user: fake-user\\n  value: fake-opaque\\nstatus: denied"}',
      '{"message":"credentials:\\n[redacted]\\nstatus: denied"}',
    ],
    [
      "{\n  note: 'credentials:\\n-\\n  user: fake-user\\n  value: fake-opaque\\nstatus: denied'\n}",
      "{\n  note: 'credentials:\\n[redacted]\\nstatus: denied'\n}",
    ],
    [
      "{\n  note: 'kind: Secret\\n' +\n    'password: |\\n' +\n    '  fake-opaque\\n' +\n    'status: denied'\n}",
      "{\n  note: 'kind: Secret\\n' +\n    'password: [redacted]\\n' +\n    'status: denied'\n}",
    ],
    [
      "{\n  note: 'kind: Secret\\n' +\n    'set-cookie:\\n' +\n    '- a=fake-opaque\\n' +\n    'status: denied'\n}",
      "{\n  note: 'kind: Secret\\n' +\n    'set-cookie:\\n' +\n    '[redacted]\\n' +\n    'status: denied'\n}",
    ],
    [
      "{\n  note: 'kind: Secret\\n' +\n    'credentials:\\n' +\n    '  user: fake-opaque\\n' +\n    'status: denied'\n}",
      "{\n  note: 'kind: Secret\\n' +\n    'credentials:\\n' +\n    '  [redacted]\\n' +\n    'status: denied'\n}",
    ],
    [
      '{"note":"set-cookie:\\n- a=fake-opaque\\nstatus: denied"}',
      '{"note":"set-cookie:\\n[redacted]\\nstatus: denied"}',
    ],
    [
      '{"h":"Authorization:\\n  Bearer fake-opaque"}',
      '{"h":"Authorization:\\n  Bearer [redacted]"}',
    ],
    [
      "{\n  note: 'token:\\n' +\n    '  user: fake-opaque\\n' +\n    'status: denied'\n}",
      "{\n  note: 'token:\\n' +\n    '  [redacted]\\n' +\n    'status: denied'\n}",
    ],
    ["password: 'fake''opaque tail'\nstatus: denied", "password: '[redacted]'\nstatus: denied"],
    ["password: 'fake\\''opaque tail'\nstatus: denied", "password: '[redacted]'\nstatus: denied"],
    ["{ password: ['fake\\''opaque tail'] }", "{ password: [redacted] }"],
    ['password: !<tag:yaml.org,2002:str> "fake-opaque tail"', 'password: "[redacted]"'],
    [
      "set-cookie: &cookies [\n  'session=fake-opaque'\n]\nstatus: denied",
      "set-cookie: [redacted]\nstatus: denied",
    ],
    [
      'Cookie: !<tag:yaml.org,2002:str> "a=fake;\n  b=fake-opaque"\nHost: x',
      'Cookie: "[redacted]"\nHost: x',
    ],
    [
      'Authorization: Digest "fake\n  fake-opaque"\nHost: x',
      'Authorization: Digest "[redacted]"\nHost: x',
    ],
    [
      'Authorization: Bearer "fake\n  fake-opaque"\nHost: x',
      'Authorization: Bearer "[redacted]"\nHost: x',
    ],
    [
      "{\n  authorization: Map(1) {\n    'value' => 'fake-opaque'\n  }\n}",
      "{\n  authorization: Map(1) [redacted]\n}",
    ],
    ["Cookie: !!str |\n  session=fake-opaque\nHost: x", "Cookie: [redacted]\nHost: x"],
    [
      "-----BEGIN RSA PRIVATE KEY-----\nfake-opaque\n-----END RSA PRIVATE KEY----- ok",
      "-----BEGIN RSA PRIVATE KEY-----[redacted]-----END RSA PRIVATE KEY----- ok",
    ],
    ["-----BEGIN PRIVATE KEY-----\nfake-opaque", "-----BEGIN PRIVATE KEY-----[redacted]"],
    [
      '{\\"url\\":\\"https://fake-user:fake-pa\\"ss@example.test/pkg',
      '{\\"url\\":\\"https://[redacted]@example.test/pkg',
    ],
    [
      "{ credentials: Credentials { value: 'fake-opaque' }, ok: 1 }",
      "{ credentials: Credentials [redacted], ok: 1 }",
    ],
    ["{ token: Map(1) { 'a' => 'fake-opaque' } }", "{ token: Map(1) [redacted] }"],
    ["{ secret: <Buffer 66 61 6b 65> }", "{ secret: [redacted] }"],
    ["Map(1) { 'token' => 'fake-opaque' }", "Map(1) { 'token' => '[redacted]' }"],
    [
      "{\n  rawHeaders: [\n    'Authorization',\n    'Basic ZmFrZS11c2VyOmZha2UtcGFzcw==',\n    'Cookie',\n    'session=fake-session'\n  ]\n}",
      "{\n  rawHeaders: [\n    'Authorization',\n    '[redacted]',\n    'Cookie',\n    '[redacted]'\n  ]\n}",
    ],
    [
      "[\n  'Host',          'example.test',\n  'Cookie',        'session=fake-session'\n]",
      "[\n  'Host',          'example.test',\n  'Cookie',        '[redacted]'\n]",
    ],
    [
      '{"rawHeaders":["Authorization","Basic ZmFrZS11c2VyOmZha2UtcGFzcw==","Cookie","session=fake-session"]}',
      '{"rawHeaders":["Authorization","[redacted]","Cookie","[redacted]"]}',
    ],
    [
      "{ headers: [ [ 'x-api-key', 'fake-api-key' ], [ 'set-cookie', [ 'a=fake-opaque' ] ], [ 'accept', '*/*' ] ] }",
      "{ headers: [ [ 'x-api-key', '[redacted]' ], [ 'set-cookie', [redacted] ], [ 'accept', '*/*' ] ] }",
    ],
    [
      '{"body":"[\\"Cookie\\",\\"session=fake-session\\"]"}',
      '{"body":"[\\"Cookie\\",\\"[redacted]\\"]"}',
    ],
    ["[ 'my-cookie', 'fake-session' ]", "[ 'my-cookie', 'fake-session' ]"],
    ["[ 'x-api-key', 424242 ]", "[ 'x-api-key', [redacted] ]"],
    ["[ 'x-api-key', -424242 ]", "[ 'x-api-key', [redacted] ]"],
    [
      '{"name":"Authorization","token"\n:"fake-opaque"}',
      '{"name":"Authorization","token"\n:"[redacted]"}',
    ],
    [
      '{"name":"Authorization","token"\r:"fake-opaque"}',
      '{"name":"Authorization","token"\r:"[redacted]"}',
    ],
    [
      '{\\"name\\":\\"Cookie\\",\\"token\\"\\r:\\"fake-opaque\\"}',
      '{\\"name\\":\\"Cookie\\",\\"token\\"\\r:\\"[redacted]\\"}',
    ],
    ["{ Symbol(token): 'fake-opaque' }", "{ Symbol(token): '[redacted]' }"],
    ['{"token":\r"fake-opaque"}', '{"token":\r"[redacted]"}'],
    ['{"token":\n\n"fake-opaque"}', '{"token":\n\n"[redacted]"}'],
    ["{ [Symbol(api token)]: 'fake-opaque' }", "{ [Symbol(api token)]: '[redacted]' }"],
    [
      '{"name":"Authorization","token":"fake-opaque"}',
      '{"name":"Authorization","token":"[redacted]"}',
    ],
    [
      "Map(2) { 'a' => 'Cookie', 'token' => 'fake-opaque' }",
      "Map(2) { 'a' => 'Cookie', 'token' => '[redacted]' }",
    ],
    ['{\n  access_token:\n    "fake-opaque"\n}', '{\n  access_token:\n    "[redacted]"\n}'],
    ["password: `fake\nfake-tail` ok", "password: `[redacted]` ok"],
    ["\u001b[32mtoken\u001b[39m: fake-opaque", "token: [redacted]"],
    ["\u001b[32mplain\u001b[39m", "\u001b[32mplain\u001b[39m"],
    ["{ stderr: '\\x1B[32mpassword\\x1B[0m: fake-opaque' }", "{ stderr: 'password: [redacted]' }"],
    [
      '{"stderr":"\\u001b[32mpassword\\u001b[0m: fake-opaque"}',
      '{"stderr":"password: [redacted]"}',
    ],
    ["{ s: '\\x1B[32mplain\\x1B[39m' }", "{ s: '\\x1B[32mplain\\x1B[39m' }"],
    [
      "\u001b]8;;https://fake-user:fake-opaque@example.test/path\u0007Open link\u001b]8;;\u0007",
      "Open link",
    ],
    ["\u001b]8;;mailto:fake-user@example.com\u001b\\Write\u001b]8;;\u001b\\", "Write"],
    ['"first\\ last"@example.com and "a\\"b"@example.com', "[email] and [email]"],
  ];

  it("redacts each credential shape and e-mail address", () => {
    for (const [input, expected] of rows) {
      assert.equal(redactSensitiveText(input), expected, input);
    }
  });

  it("redacts e-mails in JSON text after an escape and inside escaped quotes", () => {
    for (const [message, expected] of [
      ["line\nuser@example.com", "line\n[email]"],
      ["tab\tuser@example.com", "tab\t[email]"],
      ['quoted "john doe"@example.com', "quoted [email]"],
      ['quoted "first\\ last"@example.com', "quoted [email]"],
      ['quoted "a\\"b"@example.com', "quoted [email]"],
    ]) {
      assert.equal(
        redactSensitiveText(JSON.stringify({ message })),
        JSON.stringify({ message: expected }),
      );
    }
  });
});

describe("redactMessageParts", () => {
  it("masks each part after one naming a credential", () => {
    const error = new Error("denied");
    for (const [parts, expected] of [
      [
        ["Cookie", "session=fake", "token:", "fake-opaque", "using password =", 424242],
        ["Cookie", "[redacted]", "token:", "[redacted]", "using password =", "[redacted]"],
      ],
      [
        ["Could not migrate legacy Cursor credentials", error, "token:", false, "my-cookie", "x"],
        ["Could not migrate legacy Cursor credentials", error, "token:", false, "my-cookie", "x"],
      ],
      [
        ["\u001b[32mUsing token:\u001b[39m", "fake-opaque", "\u001b[1mCookie\u001b[22m", "a=b"],
        [
          "\u001b[32mUsing token:\u001b[39m",
          "[redacted]",
          "\u001b[1mCookie\u001b[22m",
          "[redacted]",
        ],
      ],
    ] as const) {
      assert.deepStrictEqual(redactMessageParts(parts), expected);
    }
  });
});

describe("stringifyRedacted", () => {
  it("redacts each string and the fields named for a credential", () => {
    const record = {
      note: "line\nuser@example.com",
      headers: {
        Authorization: "Basic dXNlcjpwYXNz",
        "set-cookie": ["session=abc"],
        "fake@example.token": "fake-opaque",
      },
      rawHeaders: ["Authorization", "Basic dXNlcjpwYXNz", "Cookie", "session=abc", "Accept", "*/*"],
      entries: [
        ["x-api-key", "fake-opaque"],
        ["set-cookie", ["session=abc"]],
        ["accept", "*/*"],
      ],
      "usage.tokens": 3,
      password: 424242,
      hasSecret: true,
      attributes: { "user@example.com": true, path: "C:\\Users\\user@example.com" },
    };
    assert.deepStrictEqual(JSON.parse(stringifyRedacted(record)), {
      note: "line\n[email]",
      headers: { Authorization: "[redacted]", "set-cookie": "[redacted]", "[email]": "[redacted]" },
      rawHeaders: ["Authorization", "[redacted]", "Cookie", "[redacted]", "Accept", "*/*"],
      entries: [
        ["x-api-key", "[redacted]"],
        ["set-cookie", "[redacted]"],
        ["accept", "*/*"],
      ],
      "usage.tokens": 3,
      password: "[redacted]",
      hasSecret: true,
      attributes: { "[email]": true, path: "C:\\Users\\[email]" },
    });
    assert.strictEqual(redactJsonText('{"password":424242}'), '{"password":"[redacted]"}');
    assert.strictEqual(
      redactJsonText('{"headers":[["Cookie","session=abc"]]}'),
      '{"headers":[["Cookie","[redacted]"]]}',
    );

    const colored = { message: "to\u001b[0mken: fake-opaque" };
    for (const json of [stringifyRedacted(colored), redactJsonText(JSON.stringify(colored))]) {
      assert.deepStrictEqual(JSON.parse(json), { message: "token: [redacted]" });
    }
  });
});

describe("redactOtlpPayload", () => {
  const span = (fields: object) => ({ resourceSpans: [{ scopeSpans: [{ spans: [fields] }] }] });

  it("redacts every string and masks attributes named for a credential", () => {
    const blob = new Uint8Array([1, 2]);
    const redacted = redactOtlpPayload(
      span({
        name: "probe user@example.com",
        attributes: [
          {
            key: "http.request.header.authorization",
            value: { stringValue: "Basic dXNlcjpwYXNz" },
          },
          { key: "pin.password", value: { intValue: 424242 } },
          { key: "has_secret", value: { boolValue: true } },
          { key: "blob", value: { bytesValue: blob } },
          {
            key: "account",
            value: { kvlistValue: { values: [{ key: "id", value: { stringValue: "a@b.io" } }] } },
          },
          {
            key: "http.raw_headers",
            value: {
              arrayValue: {
                values: [
                  { stringValue: "Authorization" },
                  { stringValue: "Basic dXNlcjpwYXNz" },
                  { stringValue: "Accept" },
                  { stringValue: "*/*" },
                ],
              },
            },
          },
          {
            key: "headers",
            value: {
              arrayValue: {
                values: [
                  {
                    arrayValue: {
                      values: [{ stringValue: "x-api-key" }, { stringValue: "fake-opaque" }],
                    },
                  },
                ],
              },
            },
          },
        ],
        links: [{ attributes: [{ key: "note", value: { stringValue: "user@example.com" } }] }],
      }),
    );

    assert.deepStrictEqual(
      redacted,
      span({
        name: "probe [email]",
        attributes: [
          { key: "http.request.header.authorization", value: { stringValue: "[redacted]" } },
          { key: "pin.password", value: { stringValue: "[redacted]" } },
          { key: "has_secret", value: { boolValue: true } },
          { key: "blob", value: { bytesValue: blob } },
          {
            key: "account",
            value: { kvlistValue: { values: [{ key: "id", value: { stringValue: "[email]" } }] } },
          },
          {
            key: "http.raw_headers",
            value: {
              arrayValue: {
                values: [
                  { stringValue: "Authorization" },
                  { stringValue: "[redacted]" },
                  { stringValue: "Accept" },
                  { stringValue: "*/*" },
                ],
              },
            },
          },
          {
            key: "headers",
            value: {
              arrayValue: {
                values: [
                  {
                    arrayValue: {
                      values: [{ stringValue: "x-api-key" }, { stringValue: "[redacted]" }],
                    },
                  },
                ],
              },
            },
          },
        ],
        links: [{ attributes: [{ key: "note", value: { stringValue: "[email]" } }] }],
      }),
    );
  });

  it("returns a clean export as is", () => {
    const clean = span({
      name: "GET /health",
      attributes: [{ key: "url.path", value: { stringValue: "/" } }],
    });
    assert.strictEqual(redactOtlpPayload(clean), clean);
  });
});
