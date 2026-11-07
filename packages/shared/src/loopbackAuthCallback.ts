// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses bounded Node listeners with AbortController cleanup.
import * as Schema from "effect/Schema";
import * as NodeHttp from "node:http";

export class LoopbackAuthCallbackError extends Schema.TaggedError<LoopbackAuthCallbackError>()(
  "LoopbackAuthCallbackError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

/** A sign-in request a caller has already validated. `state` identifies it while it waits. */
export interface LoopbackAuthRequest {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

/** The redirect port is taken on this computer, so the browser's return cannot be caught here. */
export class LoopbackPortBusyError extends Error {}

const CANCELLED = "Sign-in cancelled on this computer.";
const TIMEOUT_MS = 300_000;

const listeners = new Map<string, AbortController>();

export function cancelLoopbackAuthCallback(state: string) {
  listeners.get(state)?.abort();
}

// Browsers resolve `localhost` to either loopback address, so a redirect to it needs both.
function bindHosts(redirectUri: string) {
  switch (new URL(redirectUri).hostname) {
    case "[::1]":
      return ["::1"];
    case "localhost":
      return ["127.0.0.1", "::1"];
    default:
      return ["127.0.0.1"];
  }
}

function listen(server: NodeHttp.Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Receive an authorization code locally. Credentials and PKCE stay on the target environment. */
export async function receiveLoopbackAuthCallback(options: {
  readonly request: LoopbackAuthRequest;
  /** Returns the accepted callback URL, or throws when the response is not this sign-in's. */
  readonly validateCallback: (callbackUrl: string) => string;
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly portInUseMessage: string;
  readonly destination?: (callbackUrl: string) => string;
  readonly signal?: AbortSignal;
}) {
  const { request, signal, destination } = options;
  if (listeners.has(request.state))
    throw new Error("This sign-in is already open on this computer.");
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  signal?.addEventListener("abort", interrupted, { once: true });
  listeners.set(request.state, abort);
  const callback = Promise.withResolvers<string>();
  // Keep early open/bind failures from leaving an unobserved rejection behind.
  void callback.promise.catch(() => undefined);
  const handler: NodeHttp.RequestListener = (incoming, response) => {
    try {
      if (incoming.method !== "GET") throw new Error("method");
      const url = options.validateCallback(
        new URL(incoming.url ?? "/", request.redirectUri).toString(),
      );
      const returnUrl = destination?.(url);
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      if (returnUrl) {
        response.writeHead(303, { location: returnUrl }).end();
      } else {
        response.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        );
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3.CodeShip</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to T3.CodeShip</h1><p>Your sign-in response has been received. T3.CodeShip is finishing the connection. You can close this tab.</p></main></body></html>',
          );
      }
      callback.resolve(url);
    } catch {
      response.writeHead(400).end("This response does not belong to the active sign-in.");
    }
  };
  const hosts = bindHosts(request.redirectUri);
  const servers = hosts.map(() => NodeHttp.createServer(handler));
  const cancelled = () => callback.reject(new Error(CANCELLED));
  abort.signal.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(
    () => callback.reject(new Error("Sign-in expired. Try again.")),
    TIMEOUT_MS,
  );
  timer.unref();
  try {
    if (signal?.aborted) throw new Error(CANCELLED);
    const port = Number(new URL(request.redirectUri).port);
    const busy = new LoopbackPortBusyError(options.portInUseMessage);
    for (const [index, host] of hosts.entries()) {
      const server = servers[index]!;
      try {
        await listen(server, port, host);
      } catch (error) {
        // IPv6 can be switched off; a taken port is still a real conflict.
        const ipv6Unavailable = index > 0 && (error as NodeJS.ErrnoException).code !== "EADDRINUSE";
        if (!ipv6Unavailable) throw busy;
      }
    }
    if (abort.signal.aborted) throw new Error(CANCELLED);
    if (!(await options.openBrowser(request.authorizationUrl)))
      throw new Error("Could not open your sign-in browser.");
    return await callback.promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupted);
    abort.signal.removeEventListener("abort", cancelled);
    listeners.delete(request.state);
    await Promise.all(
      servers.map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
}
