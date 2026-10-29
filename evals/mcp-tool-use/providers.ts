// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexClient from "../../packages/effect-codex-app-server/src/client.ts";

export type EvalProvider = "openai" | "anthropic";
export interface OpenAiConnection {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly publicApi: boolean;
}

export function selectEvalProvider(input: {
  available: ReadonlyArray<EvalProvider>;
  requested?: EvalProvider | undefined;
  preferred?: EvalProvider | undefined;
}) {
  const selected = input.requested ?? input.preferred;
  if (selected) {
    if (!input.available.includes(selected))
      throw new Error(
        `The selected ${selected} provider is not available. Configure its credentials or choose another --provider.`,
      );
    return selected;
  }
  if (input.available.length === 1) return input.available[0]!;
  if (input.available.length === 0)
    throw new Error(
      "No eval provider is available. Sign in with codex login, or set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    );
  throw new Error(
    "Multiple eval providers are available. Choose --provider openai|anthropic, or set CODESHIP_EVAL_PROVIDER in .env for the default.",
  );
}

const decodeClaims = Schema.decodeUnknownSync(
  Schema.Struct({
    "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }),
  }),
);

export function openAiConnection(auth: {
  authMethod: unknown;
  authToken: string | null;
}): OpenAiConnection | undefined {
  if (!auth.authToken) return undefined;
  if (auth.authMethod === "apikey")
    return {
      url: "https://api.openai.com/v1",
      headers: { Authorization: `Bearer ${auth.authToken}` },
      publicApi: true,
    };
  if (auth.authMethod !== "chatgpt" && auth.authMethod !== "chatgptAuthTokens") return undefined;
  // The CLI refreshes the login; only the account routing claim is decoded here.
  const claims = decodeClaims(
    JSON.parse(Buffer.from(auth.authToken.split(".")[1] ?? "", "base64url").toString()),
  );
  return {
    url: "https://chatgpt.com/backend-api/codex",
    headers: {
      Authorization: `Bearer ${auth.authToken}`,
      "ChatGPT-Account-ID": claims["https://api.openai.com/auth"].chatgpt_account_id,
      originator: "codex_cli_rs",
    },
    publicApi: false,
  };
}

export const readCodexConnection = Effect.fn("evals.readCodexConnection")(
  function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.env.CODEX_BIN ?? "codex", ["app-server"], { shell: false }),
    );
    return yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      yield* client.request("initialize", {
        clientInfo: { name: "codeship-evals", title: "CodeShip evals", version: "1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: null },
      });
      yield* client.notify("initialized", undefined);
      const auth = yield* client.request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      });
      return yield* Effect.try(() => openAiConnection(auth));
    }).pipe(Effect.provide(CodexClient.layerChildProcess(child)));
  },
  Effect.scoped,
  Effect.timeout("15 seconds"),
);

export function openAiShellRequest(request: {
  model: string;
  system: string;
  messages: ReadonlyArray<{
    role: string;
    content: ReadonlyArray<{ type: string; readonly [key: string]: unknown }>;
  }>;
  output_config: { format: { schema: unknown } };
}) {
  return {
    model: request.model,
    instructions: request.system,
    input: request.messages.map(({ role, content }) => ({
      type: "message",
      role,
      content: content.map(({ text }) => ({
        type: "input_text",
        text: typeof text === "string" ? text : "",
      })),
    })),
    text: {
      format: {
        type: "json_schema",
        name: "shell_reply",
        strict: true,
        schema: request.output_config.format.schema,
      },
    },
    reasoning: { effort: "low" },
    stream: true,
    store: false,
  };
}

type Block = { readonly type: string; readonly [key: string]: unknown };
export function publicResponsesRequest<T extends { input: ReadonlyArray<Block> }>(request: T) {
  return {
    ...request,
    input: request.input.filter((item) => item.type !== "additional_tools"),
    tools: request.input.flatMap((item) =>
      item.type === "additional_tools" && Array.isArray(item.tools)
        ? item.tools.flatMap(
            (namespace: { tools?: ReadonlyArray<unknown> }) => namespace.tools ?? [],
          )
        : [],
    ),
  };
}
