import {
  DESKTOP_UPDATE_CONTROL_PATH,
  DesktopUpdateControlCommand,
  type DesktopUpdateControlAcknowledgement,
  type DesktopUpdateControlReport,
} from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

export const listen = Effect.fn("DesktopUpdateHttpControl.listen")(function* () {
  const { primary } = yield* DesktopBackendPool.DesktopBackendPool;
  const backend = yield* primary;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const client = yield* HttpClient.HttpClient;
  const endpoint = Effect.gen(function* () {
    const config = yield* backend.currentConfig;
    if (Option.isNone(config) || !config.value.bootstrap.desktopUpdateHttpControl) return null;
    const secret = config.value.bootstrap.desktopBootstrapSecret;
    if (secret === undefined) return null;
    const token = currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
    return { url: new URL(DESKTOP_UPDATE_CONTROL_PATH, config.value.httpBaseUrl), token };
  });

  const post = (
    target: { readonly url: URL; readonly token: string },
    message: DesktopUpdateControlReport | DesktopUpdateControlAcknowledgement,
  ) =>
    HttpClientRequest.post(target.url).pipe(
      HttpClientRequest.bearerToken(target.token),
      HttpClientRequest.bodyJson(message),
      Effect.flatMap(client.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout("10 seconds"),
    );

  const sendReport = Effect.fn("DesktopUpdateHttpControl.sendReport")(function* (
    report: DesktopUpdateControlReport,
  ) {
    const target = yield* endpoint;
    if (target === null) return;
    yield* post(target, report).pipe(
      Effect.catch((error) =>
        Effect.logDebug("Could not send a desktop report to the WSL backend.", { error }),
      ),
    );
  });
  let acknowledgement: DesktopUpdateControlAcknowledgement | undefined;
  const readCommands = Effect.gen(function* () {
    const target = yield* endpoint;
    if (target === null) return yield* Effect.sleep("5 seconds");
    // If the acknowledgement response is lost, resubmit it before accepting another command.
    if (acknowledgement !== undefined) {
      yield* post(target, acknowledgement);
      acknowledgement = undefined;
    }
    const latest = yield* publisher.latestUpdateReport;
    if (Option.isSome(latest)) yield* sendReport(latest.value);
    const backends = yield* Stream.runHead(publisher.servingBackends);
    if (Option.isSome(backends)) yield* sendReport(backends.value);
    const command = yield* client
      .execute(HttpClientRequest.get(target.url).pipe(HttpClientRequest.bearerToken(target.token)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(Schema.NullOr(DesktopUpdateControlCommand)),
        ),
        Effect.timeout("30 seconds"),
      );
    if (command !== null) {
      yield* publisher.handleControlForSource(backend.id, command);
      acknowledgement = {
        version: 1,
        type: "desktopUpdateControlAcknowledgement",
        requestId: command.requestId,
        command: command.type,
      };
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logDebug("Could not receive WSL desktop update commands.", { error }).pipe(
        Effect.andThen(Effect.sleep("5 seconds")),
      ),
    ),
    Effect.forever,
  );

  yield* Effect.forkScoped(Stream.runForEach(publisher.updateReports, sendReport));
  yield* Effect.forkScoped(Stream.runForEach(publisher.servingBackends, sendReport));
  yield* Effect.forkScoped(readCommands);
});
