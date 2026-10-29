import { assert, it } from "@effect/vitest";
import {
  selectEvalProvider,
  openAiConnection,
  openAiShellRequest,
  publicResponsesRequest,
} from "./providers.ts";

it("uses the sole available provider and requires a choice when both are available", () => {
  assert.equal(selectEvalProvider({ available: ["openai"] }), "openai");
  assert.equal(selectEvalProvider({ available: ["anthropic"] }), "anthropic");
  assert.throws(() => selectEvalProvider({ available: [] }), /No eval provider/);
  assert.throws(() => selectEvalProvider({ available: ["openai", "anthropic"] }), /--provider/);
  assert.equal(
    selectEvalProvider({ available: ["openai", "anthropic"], preferred: "openai" }),
    "openai",
  );
  assert.equal(
    selectEvalProvider({
      available: ["openai", "anthropic"],
      preferred: "anthropic",
      requested: "openai",
    }),
    "openai",
  );
  assert.throws(
    () => selectEvalProvider({ available: ["openai"], preferred: "anthropic" }),
    /not available/,
  );
  assert.throws(
    () => selectEvalProvider({ available: ["openai"], requested: "anthropic" }),
    /not available/,
  );
});

it("uses an OpenAI response schema for shell simulation without Anthropic options", () => {
  const request = openAiShellRequest({
    model: "gpt-6-luna",
    system: "Simulate only",
    messages: [{ role: "user", content: [{ type: "text", text: "fake command" }] }],
    output_config: { format: { schema: { type: "object" } } },
  });
  assert.equal(request.model, "gpt-6-luna");
  assert.equal(request.instructions, "Simulate only");
  assert.deepEqual(request.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "fake command" }] },
  ]);
  assert.equal(request.text.format.type, "json_schema");
  assert.notProperty(request, "max_tokens");
  assert.notProperty(request, "output_config");
});

it("moves captured tools to the public Responses schema and keeps the mocked transcript", () => {
  const request = publicResponsesRequest({
    input: [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              {
                type: "custom",
                name: "exec",
                description: "execute mocked tools",
                format: { type: "text" },
              },
            ],
          },
        ],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "test" }] },
    ],
  });
  assert.deepEqual(request.tools, [
    { type: "custom", name: "exec", description: "execute mocked tools", format: { type: "text" } },
  ]);
  assert.equal(request.input.length, 1);
});

it("keeps API keys on the public endpoint and routes CLI logins to their account", () => {
  const api = openAiConnection({ authMethod: "apikey", authToken: "test-api-key" });
  assert.equal(api?.url, "https://api.openai.com/v1");
  assert.equal(api?.publicApi, true);
  const claim = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
  ).toString("base64url");
  const token = `header.${claim}.signature`;
  const login = openAiConnection({ authMethod: "chatgpt", authToken: token });
  assert.equal(login?.url, "https://chatgpt.com/backend-api/codex");
  assert.equal(login?.headers["ChatGPT-Account-ID"], "test-account");
  assert.equal(login?.headers.Authorization, `Bearer ${token}`);
  assert.isUndefined(openAiConnection({ authMethod: null, authToken: null }));
  assert.isUndefined(openAiConnection({ authMethod: "unsupported", authToken: "test" }));
});
