import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type OrchestrationV2LinkedSender,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { unknownArguments } from "../mcp/advertisedJsonSchema.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** The only MCP protocol version a T3.CodeShip `/mcp` registers. */
const PROTOCOL_VERSION = "2025-06-18";

/** A title can be any length; the header carrying it stays well under HTTP header limits. */
const SENDER_TITLE_MAX_LENGTH = 200;

/** The limits a call carries to the peer: the calling agent's modes here. */
export interface PeerCallLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** For the server's own background reads of a link: a supervised plan-mode caller. */
export const READ_ONLY_PEER_LIMITS: PeerCallLimits = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

/** How long a background read waits for a linked machine before treating it as unreachable. */
export const PEER_READ_TIMEOUT = Duration.seconds(20);

/**
 * A peer's `/mcp` holds a wait open for its whole timeout without sending
 * anything, and T3 Connect's edge drops a request idle for about 100 s, so a
 * forwarded wait goes out in pieces no longer than this.
 */
export const FORWARDED_WAIT_CHUNK_MS = 50_000;
/**
 * What a request may take beyond its wait piece, a terminal's startup included, while the whole
 * stays under the relay's idle drop of about 100 s.
 */
const PEER_REQUEST_OVERHEAD_MS = 25_000;
const PEER_REQUEST_DEADLINE = Duration.millis(FORWARDED_WAIT_CHUNK_MS + PEER_REQUEST_OVERHEAD_MS);

interface PeerRequestOptions {
  /** Tool-specific budget when the receiving handler can legitimately outlast the default. */
  readonly deadline?: Duration.Duration | undefined;
  /** The most the tool's result may take as JSON; a larger answer is refused, never read whole. */
  readonly maxResultBytes?: number;
}

/**
 * Calls a linked environment's T3 MCP tools as this environment's outside
 * agent. Each call carries the calling agent's limits in `T3-Mode-Limit`, so
 * the peer enforces the narrower of those and the link's own access.
 */
interface PeerCallInput<S extends Schema.Decoder<unknown>> extends PeerRequestOptions {
  readonly environmentId: EnvironmentId;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly limits: PeerCallLimits;
  readonly success: S;
  readonly sender?: OrchestrationV2LinkedSender;
  /**
   * Top-level arguments a peer may lack because its version already does what they ask; a peer
   * that lacks one is called without it. Any other argument its tool's schema lacks refuses the
   * call here, naming the peer's version.
   */
  readonly ignorableArguments?: ReadonlyArray<string>;
}

export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    /** Calls `tool` on the peer and decodes its structured result with `success`. */
    readonly call: <S extends Schema.Decoder<unknown>>(
      input: PeerCallInput<S>,
    ) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
    /**
     * `call` for the server's own background work, which skips a peer that does not have `tool`,
     * such as one running an older version: none then, and the link counts as answering.
     */
    readonly callIfAvailable: <S extends Schema.Decoder<unknown>>(
      input: PeerCallInput<S>,
    ) => Effect.Effect<Option.Option<S["Type"]>, OrchestratorMcpFailure>;
    /**
     * Records on the link that part of the peer's last answer, which its caller decodes itself,
     * did not match this version, and returns the message, which names the side to update.
     */
    readonly recordUnreadable: (environmentId: EnvironmentId) => Effect.Effect<string>;
  }
>()("t3/peer/PeerMcpClient") {}

/** JSON-RPC's invalid params, which an MCP server answers for a tool it does not have. */
const INVALID_PARAMS = -32602;

const ToolCallResponse = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      structuredContent: Schema.optional(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeToolCallResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallResponse));
const decodeToolsListResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.optional(
        Schema.Struct({
          tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown })),
        }),
      ),
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
    }),
  ),
);
const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: OrchestratorMcpFailure.fields.code, message: Schema.String }),
  ),
);

/** A peer link problem, as the agent that asked hears it. */
const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired" || error.reason === "incompatible"
          ? "capability_denied"
          : error.reason === "unreachable"
            ? "unreachable"
            : "orchestration_error",
    message: error.message,
  });

/** Not final, so a task already running there resumes once the beta is on there again. */
const linkedEnvironmentsOffThere = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message:
    "The linked environment has Linked environments turned off. Turn it on in its Settings → Machines & access → Linked environments.",
});

/** One linked environment at the address it answered on, for one call. */
interface Peer {
  readonly link: PeerLinks.ResolvedPeerLink["link"];
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly label: string;
  readonly url: string;
  readonly token: string;
  readonly serverVersion: string;
  readonly limitHeader: Record<string, string>;
}

/**
 * An MCP answer carries its result twice, as escaped text and as structured content, so its body
 * takes up to about three times the result's size.
 */
const ANSWER_BYTES_PER_RESULT_BYTE = 4;

const answerTooLarge = (maxResultBytes: number) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `The linked environment's answer is larger than the ${maxResultBytes} bytes this call takes.`,
  });

/** The body as text, read no further than `maxResultBytes` allows when it is set. */
const readBody = (response: HttpClientResponse.HttpClientResponse, maxResultBytes?: number) => {
  if (maxResultBytes === undefined) return response.text;
  const maxBodyBytes = maxResultBytes * ANSWER_BYTES_PER_RESULT_BYTE;
  return Stream.runFoldEffect(
    response.stream,
    (): { readonly chunks: Array<Uint8Array>; size: number } => ({ chunks: [], size: 0 }),
    (read, chunk) => {
      read.size += chunk.byteLength;
      if (read.size > maxBodyBytes) return Effect.fail(answerTooLarge(maxResultBytes));
      read.chunks.push(chunk);
      return Effect.succeed(read);
    },
  ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks).toString("utf8")));
};

/** The body of an MCP response: JSON, or a single server-sent event carrying JSON. */
const responseJson = (contentType: string | undefined, text: string) =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  // One MCP session per peer and address, reused across calls. The peer keeps
  // sessions in memory, so a restart there answers 404 and we start a new one.
  const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  // Each peer's tool input schemas, as listed in one session of one version.
  const inputSchemas = yield* Ref.make<
    ReadonlyMap<
      string,
      {
        readonly sessionId: string;
        readonly serverVersion: string;
        readonly schemas: ReadonlyMap<string, unknown>;
      }
    >
  >(new Map());

  const scopedHttp = HttpClient.withScope(httpClient);
  const post = (
    url: string,
    token: string,
    body: unknown,
    headers: Record<string, string>,
    options?: PeerRequestOptions,
  ) => {
    const request = HttpClientRequest.post(`${url}/mcp`).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...headers,
      }),
      HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
    );
    return scopedHttp.execute(request).pipe(
      Effect.flatMap((response) =>
        (response.status === 200
          ? readBody(response, options?.maxResultBytes)
          : Effect.succeed("")
        ).pipe(
          Effect.map((body) => ({ status: response.status, headers: response.headers, body })),
        ),
      ),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: options?.deadline ?? PEER_REQUEST_DEADLINE,
        orElse: () =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "Peer MCP request deadline exceeded",
              }),
            }),
          ),
      }),
    );
  };

  // A peer that renews a used link says when it now ends; one that does not sends nothing.
  const recordLinkExpiry = (
    link: PeerLinks.ResolvedPeerLink["link"],
    headers: Readonly<Record<string, string>>,
  ) =>
    Option.match(
      Option.filter(
        Option.flatMap(
          Option.fromNullishOr(headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]),
          DateTime.make,
        ),
        (expiresAt) => !DateTime.Equivalence(expiresAt, link.expiresAt),
      ),
      {
        onNone: () => Effect.void,
        onSome: (expiresAt) => links.recordExpiry(link.environmentId, expiresAt),
      },
    );

  const openSession = Effect.fn("PeerMcpClient.openSession")(
    function* (
      { link, url, token }: Pick<Peer, "link" | "url" | "token">,
      limitHeader: Record<string, string>,
    ) {
      const initialized = yield* post(
        url,
        token,
        {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "t3code-peer", version: "1" },
          },
        },
        limitHeader,
      );
      const sessionId = initialized.headers["mcp-session-id"];
      if (initialized.status === 403) return yield* linkedEnvironmentsOffThere;
      if (initialized.status !== 200 || sessionId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: initialized.status === 401 ? "capability_denied" : "orchestration_error",
          message:
            initialized.status === 401
              ? "The linked environment no longer accepts this link. It may have been revoked there; link it again."
              : `The linked environment refused to start an MCP session (HTTP ${initialized.status}).`,
        });
      }
      yield* recordLinkExpiry(link, initialized.headers);
      yield* post(
        url,
        token,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
      );
      return sessionId;
    },
    // Only the handshake is bounded: a forwarded tool call may wait for minutes.
    (effect, { url }) => Effect.timeout(effect, PeerLinks.probeTimeout(url)),
  );

  /** It answered, so it is up, but on a version that answers in a way this one cannot read. */
  const unreadable = (peer: Peer) =>
    links.recordUnreadable(peer.environmentId, peer.serverVersion).pipe(
      Effect.andThen(
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "version_mismatch",
            message: PeerLinks.unreadableAnswerMessage(peer),
          }),
        ),
      ),
    );

  const startSession = Effect.fnUntraced(function* (peer: Peer) {
    const sessionId = yield* openSession(peer, peer.limitHeader);
    // The initialized session outlives a request, including a long wait or cancellation.
    yield* Ref.update(sessions, (current) => new Map(current).set(peer.key, sessionId));
    return sessionId;
  });

  const currentSession = (peer: Peer) =>
    Ref.get(sessions).pipe(
      Effect.flatMap((current) => {
        const sessionId = current.get(peer.key);
        return sessionId === undefined ? startSession(peer) : Effect.succeed(sessionId);
      }),
    );

  /**
   * Posts the body `prepared` gives in its session, and once more after starting a new one when the
   * peer lost it. The peer may run other code then, so `prepared` runs again for the new one.
   */
  const send = Effect.fnUntraced(function* (
    peer: Peer,
    prepared: Effect.Effect<
      { readonly sessionId: string; readonly body: unknown },
      OrchestratorMcpFailure | HttpClientError.HttpClientError | Cause.TimeoutError
    >,
    options?: PeerRequestOptions,
  ) {
    const attempt = Effect.flatMap(prepared, ({ sessionId, body }) =>
      post(
        peer.url,
        peer.token,
        body,
        {
          ...peer.limitHeader,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        options,
      ).pipe(Effect.map((response) => ({ sessionId, response }))),
    );
    let sent = yield* attempt;
    if (sent.response.status === 404) {
      yield* startSession(peer);
      sent = yield* attempt;
    }
    const { response } = sent;
    if (response.status === 401) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
      });
    }
    if (response.status === 403) return yield* linkedEnvironmentsOffThere;
    // A server error comes from the machine or a gateway on its route, after the call may have run.
    if (response.status >= 500) {
      return yield* new OrchestratorMcpFailure({
        code: "no_answer",
        message: `The linked environment's address answered HTTP ${response.status}, so whether it acted is unknown.`,
      });
    }
    if (response.status !== 200) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `The linked environment answered HTTP ${response.status}.`,
      });
    }
    yield* recordLinkExpiry(peer.link, response.headers);
    return sent;
  });

  const listInputSchemas = Effect.fnUntraced(function* (peer: Peer) {
    const { sessionId, response } = yield* send(
      peer,
      Effect.map(currentSession(peer), (sessionId) => ({
        sessionId,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      })),
    );
    const listed = yield* decodeToolsListResponse(
      responseJson(response.headers["content-type"], response.body),
    ).pipe(Effect.catch(() => unreadable(peer)));
    if (listed.error !== undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: listed.error.message,
      });
    }
    if (listed.result === undefined) return yield* unreadable(peer);
    const schemas = new Map(listed.result.tools.map((tool) => [tool.name, tool.inputSchema]));
    const stillCurrent = (yield* Ref.get(sessions)).get(peer.key) === sessionId;
    if (stillCurrent) {
      yield* Ref.update(inputSchemas, (current) =>
        new Map(current).set(peer.key, { sessionId, serverVersion: peer.serverVersion, schemas }),
      );
    }
    return { sessionId, schemas, stillCurrent };
  });

  /**
   * The session to call in and the arguments to send there, once the peer's tool takes them all.
   * Ignorable arguments it lacks are left out, since its server refuses or drops arguments it
   * does not list. A peer without the tool is left to say so.
   */
  const checkedCall = Effect.fnUntraced(function* (
    peer: Peer,
    input: PeerCallInput<Schema.Decoder<unknown>>,
  ) {
    if (Object.values(input.arguments).every((value) => value === undefined)) {
      return { sessionId: yield* currentSession(peer), toolArguments: input.arguments };
    }
    const ignorable = new Set(input.ignorableArguments);
    const fitTo = (schemas: ReadonlyMap<string, unknown>) => {
      const lacked = schemas.has(input.tool)
        ? unknownArguments(schemas.get(input.tool), input.arguments)
        : [];
      return {
        unknown: lacked.filter((key) => !ignorable.has(key)),
        toolArguments: Object.fromEntries(
          Object.entries(input.arguments).filter(([key]) => !lacked.includes(key)),
        ),
      };
    };
    // A pass ends without an answer only when another call started a new session while it listed.
    while (true) {
      const sessionId = (yield* Ref.get(sessions)).get(peer.key);
      const cached = (yield* Ref.get(inputSchemas)).get(peer.key);
      if (
        cached !== undefined &&
        cached.sessionId === sessionId &&
        cached.serverVersion === peer.serverVersion
      ) {
        const fit = fitTo(cached.schemas);
        if (fit.unknown.length === 0) {
          return { sessionId: cached.sessionId, toolArguments: fit.toolArguments };
        }
      }
      // Listed again before a refusal, since the peer may have restarted since.
      const listed = yield* listInputSchemas(peer);
      const { unknown, toolArguments } = fitTo(listed.schemas);
      if (unknown.length === 0) return { sessionId: listed.sessionId, toolArguments };
      if (!listed.stillCurrent) continue;
      const them = unknown.length === 1 ? "it" : "them";
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `${peer.label} runs T3.CodeShip ${peer.serverVersion}, whose ${input.tool} does not take ${unknown.join(", ")}. Update T3.CodeShip on ${peer.label} to use ${them}, or leave ${them} out.`,
      });
    }
  });

  /**
   * The peer's result decoded with `success`, or none when the peer has no such tool. Its callers
   * own the span and record the outcome on the link.
   */
  const request = Effect.fnUntraced(function* (input: PeerCallInput<Schema.Decoder<unknown>>) {
    const resolved = yield* links.resolve(input.environmentId).pipe(Effect.mapError(fromLinkError));
    const peer: Peer = {
      link: resolved.link,
      environmentId: input.environmentId,
      key: `${input.environmentId} ${resolved.url}`,
      label: resolved.link.label,
      url: resolved.url,
      token: resolved.token,
      serverVersion: resolved.serverVersion,
      limitHeader: {
        [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
        ...(input.sender === undefined
          ? {}
          : {
              [McpInvocationContext.SENDER_THREAD_HEADER]: [
                input.sender.environmentId,
                input.sender.threadId,
                Array.from(input.sender.title).slice(0, SENDER_TITLE_MAX_LENGTH).join(""),
              ]
                .map((part) => encodeURIComponent(part.toWellFormed()))
                .join("/"),
            }),
      },
    };
    const { response } = yield* send(
      peer,
      Effect.map(checkedCall(peer, input), ({ sessionId, toolArguments }) => ({
        sessionId,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: input.tool, arguments: toolArguments },
        },
      })),
      input,
    );
    const body = yield* decodeToolCallResponse(
      responseJson(response.headers["content-type"], response.body),
    ).pipe(Effect.catch(() => unreadable(peer)));
    if (
      body.error?.code === INVALID_PARAMS &&
      body.error.message === `Tool '${input.tool}' not found`
    ) {
      return Result.succeed(Option.none<unknown>());
    }
    if (body.error !== undefined)
      return Result.fail(
        new OrchestratorMcpFailure({ code: "invalid_request", message: body.error.message }),
      );
    if (body.result === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The linked environment returned no result.",
      });
    }
    const text = body.result.content.map((part) => part.text ?? "").join("");
    if (
      input.maxResultBytes !== undefined &&
      Buffer.byteLength(text, "utf8") > input.maxResultBytes
    ) {
      return yield* answerTooLarge(input.maxResultBytes);
    }
    if (body.result.isError === true) {
      // A refusal keeps the peer's own code, so the agent sees why it was refused.
      const refused = decodeFailure(text);
      return Result.fail(
        refused._tag === "Some"
          ? new OrchestratorMcpFailure({ code: refused.value.code, message: refused.value.message })
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: text || "The linked environment refused the call.",
            }),
      );
    }
    const { success } = input;
    return Result.succeed(
      Option.some(
        yield* Schema.decodeEffect(Schema.fromJsonString(success))(text).pipe(
          Effect.catch(() => unreadable(peer)),
        ),
      ),
    );
  });

  const recorded = <A>(
    effect: Effect.Effect<
      A,
      OrchestratorMcpFailure | HttpClientError.HttpClientError | Cause.TimeoutError
    >,
    input: { readonly environmentId: EnvironmentId },
  ) =>
    effect.pipe(
      Effect.tapError((error) =>
        links.recordOutcome(input.environmentId, { error: error.message }),
      ),
      Effect.tap(() => links.recordOutcome(input.environmentId, { error: null })),
      // Recorded above with the transport's own message; the agent hears it plainly. The request
      // may have reached there, so it is no answer, not a refusal.
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment stopped answering.",
            }),
          ),
        HttpClientError: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "no_answer",
              message: "The linked environment stopped answering.",
            }),
          ),
      }),
    );

  const call: PeerMcpClient["Service"]["call"] = Effect.fn("PeerMcpClient.call")(function* (input) {
    const result = yield* recorded(request(input), input).pipe(Effect.flatMap(Effect.fromResult));
    if (Option.isNone(result)) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Tool '${input.tool}' not found`,
      });
    }
    return result.value;
  });

  const callIfAvailable: PeerMcpClient["Service"]["callIfAvailable"] = Effect.fn(
    "PeerMcpClient.callIfAvailable",
  )(function* (input) {
    return yield* recorded(request(input), input).pipe(Effect.flatMap(Effect.fromResult));
  });

  const recordUnreadable: PeerMcpClient["Service"]["recordUnreadable"] = Effect.fn(
    "PeerMcpClient.recordUnreadable",
  )(function* (environmentId) {
    const resolved = yield* links.resolve(environmentId).pipe(Effect.option);
    // A peer that stopped answering has no version to compare, so the message names neither side.
    const message = PeerLinks.unreadableAnswerMessage(
      Option.isSome(resolved)
        ? { label: resolved.value.link.label, serverVersion: resolved.value.serverVersion }
        : { label: "", serverVersion: "" },
    );
    yield* links.recordOutcome(environmentId, { error: message });
    if (Option.isSome(resolved)) {
      yield* links.recordUnreadable(environmentId, resolved.value.serverVersion);
    }
    return message;
  });

  return PeerMcpClient.of({ call, callIfAvailable, recordUnreadable });
});

export const layer = Layer.effect(PeerMcpClient, make);
