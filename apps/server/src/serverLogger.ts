import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SharedObservability from "@t3tools/shared/observability";
import { redactMessageParts, redactSensitiveText } from "@t3tools/shared/redaction";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpLogger from "effect/observability/OtlpLogger";

import * as ServerConfig from "./config.ts";

// consolePretty collapses Cause fields via util.inspect; render them with Cause.pretty like standalone arguments.
const consolePretty = (): Logger.Logger<unknown, void> => {
  const pretty = Logger.consolePretty();
  return Logger.make((options) =>
    pretty.log({
      ...options,
      message: Array.isArray(options.message)
        ? options.message.map(prettyCauseFields)
        : prettyCauseFields(options.message),
      fiber: withRedactingConsole(options.fiber),
    }),
  );
};

// Provider errors can name the signed-in account, and HTTP errors carry the request's connection
// ticket. The pretty logger prints message, cause and annotations through the fiber's console, so
// it gets one that redacts the text Node would print.
function withRedactingConsole(fiber: Fiber.Fiber<unknown, unknown>): Fiber.Fiber<unknown, unknown> {
  const console = fiber.getRef(Console.Console);
  const redacting: Console.Console = {
    ...console,
    log: (...args) => console.log(printable(process.stdout, args)),
    error: (...args) => console.error(printable(process.stderr, args)),
  };
  const getRef = <A>(ref: Context.Reference<A>): A =>
    (ref as Context.Reference<unknown>) === Console.Console ? (redacting as A) : fiber.getRef(ref);
  return Object.create(fiber, { getRef: { value: getRef } }) as Fiber.Fiber<unknown, unknown>;
}

// Formats once, colored as Node's console would for `stream`, and prints that very text: formatting
// again could print an object differently from what was checked. Strings print whole, since cutting
// one can split a credential from what marks it, such as a URL's `@`.
function printable(stream: NodeJS.WriteStream, args: ReadonlyArray<unknown>): string {
  const colors =
    stream.isTTY === true &&
    typeof stream.getColorDepth === "function" &&
    stream.getColorDepth() > 2;
  return redactSensitiveText(
    NodeUtil.formatWithOptions({ colors, maxStringLength: Infinity }, ...args),
  );
}

const withRedactedMessage = <Output>(
  logger: Logger.Logger<unknown, Output>,
): Logger.Logger<unknown, Output> =>
  Logger.make((options) =>
    logger.log({ ...options, message: redactMessageParts(options.message) }),
  );

function prettyCauseFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  // A message with its own redaction hook already decides how it prints.
  if (Redactable.isRedactable(value)) return value;
  // Copy descriptors to preserve symbols without invoking getters.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor && Cause.isCause(descriptor.value)) {
      descriptor.value = Cause.pretty(descriptor.value);
      changed = true;
    }
  }
  return changed ? Object.create(prototype, descriptors) : value;
}

export const layer = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const hostName = yield* HostProcess.Hostname;
  const layerMinimumLogLevel = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  const logs = config.otlpLogsExport;
  const otlpLogger =
    config.otlpLogsUrl === undefined
      ? undefined
      : OtlpLogger.make({
          url: config.otlpLogsUrl,
          exportInterval: `${logs.exportIntervalMs} millis`,
          headers: logs.headers,
          resource: ServerConfig.otlpResource(config, hostName),
        });

  // Logger.layer replaces the whole set; name every logger here.
  // OTLP includes traced messages as log records, so also using tracerLogger would duplicate in-span exports.
  const prettyLogger = withRedactedMessage(consolePretty());
  const layerLogger = Logger.layer(
    otlpLogger === undefined
      ? [prettyLogger, withRedactedMessage(Logger.tracerLogger)]
      : [prettyLogger, Effect.map(otlpLogger, withRedactedMessage)],
    { mergeWithExisting: false },
  ).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(SharedObservability.layerOtlpSerialization(logs.protocol)),
  );

  return Layer.mergeAll(layerLogger, layerMinimumLogLevel);
}).pipe(Layer.unwrap);
