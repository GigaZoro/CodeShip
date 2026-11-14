// These guards run on the raw Node HTTP server before Effect handles requests.
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import {
  ENVIRONMENT_DESCRIPTOR_PATH,
  type EnvironmentStartingResponse,
  type EnvironmentStartup,
} from "@t3tools/contracts";

export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (_request, response) => {
    response.on("error", (error) => {
      onError?.(error);
    });
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
  });
  return server;
}

/**
 * NodeHttpServer listens before serve() attaches its handlers, so requests in between would hang.
 * Install this after the write-error guards so only the serving handlers trigger the handoff.
 * The descriptor path's 503 carries a running migration, so clients can tell busy from dead.
 */
export function rejectRequestsUntilServing<T extends NodeHttp.Server>(
  server: T,
  startup: () => EnvironmentStartup | undefined = () => undefined,
): T {
  const rejectRequest = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const status =
      request.method === "GET" && request.url?.split("?")[0] === ENVIRONMENT_DESCRIPTOR_PATH
        ? startup()
        : undefined;
    if (status === undefined) {
      response.writeHead(503, { "retry-after": "1", connection: "close" }).end();
      return;
    }
    const body: EnvironmentStartingResponse = { startup: status };
    response
      .writeHead(503, {
        "retry-after": "1",
        "content-type": "application/json",
        "cache-control": "no-store",
        connection: "close",
      })
      .end(JSON.stringify(body));
  };
  const rejectUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  server.on("request", rejectRequest);
  server.on("upgrade", rejectUpgrade);
  // Node emits newListener before adding the handler, making the handoff synchronous.
  server.on("newListener", function onNewListener(event) {
    if (event === "request") server.off("request", rejectRequest);
    if (event === "upgrade") server.off("upgrade", rejectUpgrade);
    if (
      !server.listeners("request").includes(rejectRequest) &&
      !server.listeners("upgrade").includes(rejectUpgrade)
    ) {
      server.off("newListener", onNewListener);
    }
  });
  return server;
}
