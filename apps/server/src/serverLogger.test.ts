import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import { ExternalLauncherBrowserSpawnError } from "@t3tools/contracts/editor";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redactable from "effect/Redactable";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestConsole from "effect/testing/TestConsole";

import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

import * as ServerConfig from "./config.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ServerLogger from "./serverLogger.ts";
import {
  announceStartupPairingUrl,
  logBrowserAutoOpenUnavailable,
  maybeOpenBrowser,
} from "./serverRuntimeStartup.ts";

interface ExportedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const layerCollector = (requests: Array<ExportedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

const layerConfig = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.join(NodeOS.tmpdir(), "t3-server-logger-test");
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      return ServerConfig.make({
        logLevel: "Info",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        cwd: baseDir,
        baseDir,
        ...derivedPaths,
        mode: "web",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        port: 0,
        host: undefined,
        desktopBootstrapToken: undefined,
        desktopTelemetryFd: undefined,
        desktopTelemetryControlFd: undefined,
        resourceMonitorPath: undefined,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: false,
        startupPresentation: "browser",
        ...overrides,
      });
    }),
  ).pipe(Layer.provide(NodePath.layer));

/**
 * Runs `program` (one log line by default) inside a span so the tracer logger
 * has somewhere to attach an event, then reports both what the collector
 * received and what landed on the span.
 */
const logInSpanThrough = (
  overrides: Partial<ServerConfig.ServerConfig["Service"]>,
  program: Effect.Effect<void> = Effect.log("server logger under test"),
) =>
  Effect.gen(function* () {
    const requests: Array<ExportedRequest> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (spanOptions) => {
          const span = new Tracer.NativeSpan(spanOptions);
          spans.push(span);
          return span;
        },
      }),
    );
    yield* program.pipe(
      Effect.withSpan("server-logger-test"),
      Effect.provide(
        Layer.mergeAll(
          ServerLogger.layer.pipe(
            Layer.provide(layerConfig(overrides)),
            Layer.provide(layerCollector(requests)),
          ),
          layerTracer,
        ),
      ),
    );
    return { requests, spans };
  });

// The pretty logger colors its output when stdout is a terminal, as it is for `npx t3`.
const stdoutAsTerminal = (isTTY: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
      return previous;
    }),
    (previous) =>
      Effect.sync(() =>
        previous === undefined
          ? Reflect.deleteProperty(process.stdout, "isTTY")
          : Object.defineProperty(process.stdout, "isTTY", previous),
      ),
  );

const printThroughConsole = (
  fields: object,
  annotations: Record<string, unknown> = {},
  isTTY = false,
  parts: ReadonlyArray<unknown> = [],
) =>
  Effect.gen(function* () {
    yield* stdoutAsTerminal(isTTY);
    const printed: Array<string> = [];
    const testConsole = {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        printed.push(NodeUtil.format(...args));
      },
    } satisfies Console.Console;
    yield* Effect.logWarning("pull request watch check failed", fields, ...parts).pipe(
      Effect.annotateLogs(annotations),
      Effect.provide(
        ServerLogger.layer.pipe(Layer.provide(layerConfig({})), Layer.provide(layerCollector([]))),
      ),
      Effect.provideService(Console.Console, testConsole),
    );
    return printed.join("\n");
  }).pipe(Effect.scoped);

describe("ServerLoggerLive", () => {
  it.effect("exports the operator's service instance id instead of a generated one", () =>
    Effect.gen(function* () {
      const { requests } = yield* logInSpanThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
        otelEnvironment: {
          ...OtelEnvironment.none,
          resourceAttributes: { "service.instance.id": "pod-7" },
        },
      });

      const body = requests.map((request) => request.body).join("\n");
      assert.include(body, '"key":"service.instance.id","value":{"stringValue":"pod-7"}');
    }),
  );

  it.effect("exports a resource that names whether the desktop app launched the server", () =>
    Effect.gen(function* () {
      const { requests } = yield* logInSpanThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
        mode: "desktop",
      });

      const body = requests.map((request) => request.body).join("\n");
      assert.include(body, '"key":"t3code.server.managed_by","value":{"stringValue":"desktop"}');
      assert.notInclude(body, "service.mode");
    }),
  );

  it.effect("exports logged failures without connection tickets or e-mail addresses", () =>
    Effect.gen(function* () {
      const { requests } = yield* logInSpanThrough(
        { otlpLogsUrl: "https://collector.example.com/v1/logs" },
        Effect.logError(
          "Usage read failed for user@example.com",
          { account: "user@example.com" },
          "token:",
          "fake-opaque",
          Cause.die(
            new Error("RequestParseError (GET /ws?wsTicket=ticket-secret&dpop=proof-secret)"),
          ),
        ).pipe(Effect.annotateLogs({ detail: "remote: denied to user@example.com" })),
      );

      const body = requests.map((request) => request.body).join("\n");
      assert.include(body, "wsTicket=[redacted]&dpop=[redacted]");
      assert.include(body, "Usage read failed for [email]");
      assert.notInclude(body, "ticket-secret");
      assert.notInclude(body, "proof-secret");
      assert.notInclude(body, "user@example.com");
      assert.notInclude(body, "fake-opaque");
    }),
  );

  it.effect("prints a cause passed as a log field, redacted, instead of collapsing it", () =>
    Effect.gen(function* () {
      class Session {
        readonly owner = "user@example.com";
        readonly token = "fake-session-token";
        toString(): string {
          return "Session";
        }
      }
      for (const isTTY of [false, true]) {
        const output = yield* printThroughConsole(
          {
            threadId: "thread-1",
            // Node cuts a string at 10,000 characters: here just past the password, before its `@`.
            note: `${"x".repeat(9_968)} https://fake-user:fake-password@example.test/path`,
            account: "user@example.com",
            session: new Session(),
            [Symbol("owner")]: "user@example.com",
            cause: Cause.fail(new Error("gh: HTTP 502 from api.github.com for user@example.com")),
          },
          { detail: "remote: denied to user@example.com", authorization: "Basic dXNlcjpwYXNz" },
          isTTY,
          ["Cookie", "fake-cookie-value"],
        );

        assert.include(output, "threadId: 'thread-1'");
        assert.include(output, "remote: denied to [email]");
        assert.include(output, "gh: HTTP 502 from api.github.com for [email]");
        assert.include(output, "authorization: Basic [redacted]");
        assert.notInclude(output, "user@example.com");
        assert.notInclude(output, "fake-session-token");
        assert.notInclude(output, "dXNlcjpwYXNz");
        assert.notInclude(output, "fake-password");
        assert.notInclude(output, "fake-cookie-value");
        assert.notInclude(output, "[Object]");
      }

      let inspections = 0;
      const shifty = {
        [NodeUtil.inspect.custom]: () => (inspections++ === 0 ? "Session" : "user@example.com"),
      };
      const printed = yield* printThroughConsole({ session: shifty });
      assert.notInclude(printed, "user@example.com");
    }),
  );

  // regression: #16642 logs printed causes as [Object]
  it.effect("leaves getters uncalled while printing a cause field", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        cause: Cause.fail(new Error("upstream refused")),
        get detail(): string {
          throw new Error("getter must not run");
        },
      });

      assert.include(output, "upstream refused");
      assert.notInclude(output, "getter must not run");
    }),
  );

  it.effect("leaves a message with its own redaction hook to that hook", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        token: "secret-token-value",
        cause: Cause.fail(new Error("upstream refused")),
        [Redactable.symbolRedactable](this: { readonly cause: unknown }) {
          return { token: "<redacted>", cause: Cause.isCause(this.cause) ? "cause" : "missing" };
        },
      });

      assert.include(output, "token: '[redacted]'");
      assert.include(output, "cause: 'cause'");
      assert.notInclude(output, "secret-token-value");
    }),
  );

  describe("startup pairing URL", () => {
    const pairingToken = "PAIRTOKEN7Q4K9";
    const pairingUrl = `http://localhost:3773/pair#token=${pairingToken}`;
    const announce = announceStartupPairingUrl(pairingUrl).pipe(
      Effect.andThen(logBrowserAutoOpenUnavailable),
    );

    it.effect("prints the full URL but keeps its token out of exported log records", () =>
      Effect.gen(function* () {
        const { requests } = yield* logInSpanThrough(
          { otlpLogsUrl: "https://collector.example.com/v1/logs" },
          announce,
        );

        const body = requests.map((request) => request.body).join("\n");
        assert.include(body, "Authentication required");
        assert.notInclude(body, pairingToken);
        const printed = (yield* TestConsole.logLines).map((line) =>
          Array.isArray(line) ? line.join(" ") : String(line),
        );
        assert.isTrue(printed.some((line) => line.includes(`pairingUrl: ${pairingUrl}`)));
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("keeps the token off the span events the trace file records", () =>
      Effect.gen(function* () {
        const { spans } = yield* logInSpanThrough({}, announce);

        const events = JSON.stringify(
          spans.flatMap((span) => span.events.map(([name, , attributes]) => [name, attributes])),
        );
        assert.include(events, "Authentication required");
        assert.notInclude(events, pairingToken);
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("keeps the token out of traces when the browser fails to open", () =>
      Effect.gen(function* () {
        const failingLaunch = maybeOpenBrowser(pairingUrl).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerConfig({ noBrowser: false }),
              Layer.mock(ExternalLauncher.ExternalLauncher)({
                launchBrowser: (target) =>
                  Effect.fail(
                    new ExternalLauncherBrowserSpawnError({
                      target,
                      command: "xdg-open",
                      args: [target],
                      cause: new Error("spawn xdg-open ENOENT"),
                    }),
                  ).pipe(Effect.withSpan("externalLauncher.launchBrowser")),
              }),
            ),
          ),
        );
        const { spans } = yield* logInSpanThrough({}, failingLaunch);

        const recorded = JSON.stringify(
          spans.map((span) => ({
            name: span.name,
            events: span.events.map(([name, , attributes]) => [name, attributes]),
            exit:
              span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
                ? Cause.pretty(span.status.exit.cause)
                : null,
          })),
        );
        assert.include(recorded, "browser auto-open unavailable");
        assert.notInclude(recorded, pairingToken);
      }),
    );
  });
});
