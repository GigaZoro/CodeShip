// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexClient from "../../packages/effect-codex-app-server/src/client.ts";
import {
  type CodexRateLimitSnapshot,
  codexRateLimitsToWindows,
  codexUsageLimitResetAt,
} from "../../apps/server/src/provider/codexUsageLimits.ts";

export type EvalProvider = "openai" | "anthropic";
export interface OpenAiConnection {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly publicApi: boolean;
  /** The Codex home whose login signs the requests, for a Codex login. */
  readonly login?: string;
}

/** Why a Codex login cannot run samples now, or undefined when it can. */
export function codexUsageBlock(usage: {
  readonly ordinaryUsageAllowed?: boolean | null;
  readonly rateLimits: CodexRateLimitSnapshot;
  readonly rateLimitsByLimitId?: Readonly<Record<string, CodexRateLimitSnapshot>> | null;
}): string | undefined {
  const snapshot = usage.rateLimitsByLimitId?.codex ?? usage.rateLimits;
  // The backend's permission decides; window percentages stand in only when it gives none.
  const allowed =
    usage.ordinaryUsageAllowed ??
    !codexRateLimitsToWindows(snapshot).some((window) => window.usedPercent >= 100);
  if (allowed) return undefined;
  return `out of usage until ${codexUsageLimitResetAt(snapshot) ?? "an unknown time"}`;
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
        clientInfo: { name: "codeship-evals", title: "T3.CodeShip evals", version: "1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: null },
      });
      yield* client.notify("initialized", undefined);
      const auth = yield* client.request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      });
      const connection = yield* Effect.try(() => openAiConnection(auth));
      if (!connection) return undefined;
      const login = process.env.CODEX_HOME?.trim() || "~/.codex";
      // An exhausted plan login fails every sample after minutes of 429 retries; stop before the first.
      const blocked = connection.publicApi
        ? undefined
        : yield* client.request("account/rateLimits/read", null).pipe(
            Effect.map(codexUsageBlock),
            Effect.timeout("5 seconds"),
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not read the Codex login's usage; running anyway.",
                cause,
              ).pipe(Effect.as(undefined)),
            ),
          );
      if (blocked)
        return yield* Effect.die(
          new Error(
            `The Codex login in ${login} is ${blocked}. Set CODEX_HOME to a Codex home whose login has usage left.`,
          ),
        );
      return { ...connection, login };
    }).pipe(Effect.provide(CodexClient.layerChildProcess(child)));
  },
  Effect.scoped,
  // Sign-in's 15 seconds plus the usage read's own 5, so a slow read cannot cost the sign-in.
  Effect.timeout("20 seconds"),
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
