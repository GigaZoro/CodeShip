import type {
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts/providerUsageLimits";
import type { AcpSessionRuntime } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const MAX_REPORT_LENGTH = 64_000;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

const TokenFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
});
const UserInfo = Schema.Struct({
  id: Schema.NonEmptyString,
});

const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);

export function supportsAntigravityAcpQuota(version: string | null | undefined): boolean {
  const release = version?.trim();
  return release === "1.4.5" || release === "1.5.2";
}

export function unavailableAntigravityLimits(
  checkedAt: string,
  reason: "unsupported" | "probeFailed",
): ServerProviderUsageLimits {
  return { ...makeUnavailableUsageLimits({ checkedAt, reason }), source: "antigravity-acp" };
}

function groupScope(group: string): ServerProviderUsageWindow["scope"] {
  if (/^gemini(?: models)?$/i.test(group)) return "gemini-default";
  if (/^gemini(?: 4)? argon(?: models)?$/i.test(group)) return "gemini-argon";
  if (/^claude (?:and|&) gpt(?: models)?$/i.test(group)) return "third-party";
  return "unknown";
}

/** The managed ACP runtime formats percentages and reset clocks under its Quota Limits heading. */
export function parseAntigravityUsageReport(
  report: string,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows: ServerProviderUsageWindow[] = [];
  let group = "";
  let limits = false;
  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith("#")) {
      limits = line === "### Quota Limits";
      group = "";
      continue;
    }
    if (!limits) continue;
    const heading = /^- \*\*(.+)\*\*$/.exec(line);
    if (heading) {
      group = heading[1]!.trim();
      continue;
    }
    const row = /^  - \*\*(.+?):\*\* (\d{1,3})% remaining(?: \(resets (.+)\))?$/.exec(line);
    if (!row || !group || Number(row[2]) > 100) continue;
    const bucket = row[1]!;
    const scope = groupScope(group);
    const kind = /weekly|\bweek\b/i.test(bucket)
      ? "weekly"
      : /\b(?:5|five)[ -]?(?:h|hours?)\b/i.test(bucket)
        ? "session"
        : "other";
    const family = scope === "gemini-default" ? "gemini" : scope === "third-party" ? "3p" : scope;
    const slug = (value: string) => encodeURIComponent(value.toLowerCase());
    const prefix = scope === "unknown" ? `group-${slug(group)}` : family;
    const id = `${prefix}-${kind === "session" ? "5h" : kind === "weekly" ? "weekly" : slug(bucket)}`;
    const windowDurationMins = kind === "weekly" ? 10_080 : kind === "session" ? 300 : undefined;
    const resetMs = row[3] ? Date.parse(row[3]) : NaN;
    const usedPercent = 100 - Number(row[2]);
    // Idle buckets have rolling full-window clocks; the ACP report rounds resets to the minute.
    const idle =
      usedPercent === 0 &&
      windowDurationMins !== undefined &&
      Math.abs(resetMs - Date.parse(checkedAt) - windowDurationMins * 60_000) <= 60_000;
    windows.push({
      id,
      kind,
      scope,
      usedPercent,
      observedAt: checkedAt,
      label: `${group} · ${bucket}`,
      ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      ...(Number.isFinite(resetMs) && resetMs > 0 && !idle
        ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)) }
        : {}),
    });
  }
  return windows.length
    ? { ...makeUsageLimits({ checkedAt, windows }), source: "antigravity-acp" }
    : unavailableAntigravityLimits(checkedAt, "probeFailed");
}

/**
 * Resolves a stable cross-environment fingerprint from the active Antigravity OAuth token.
 * Caches successful Google account ID lookups per token and falls back without failing the probe.
 */
export const makeAntigravityCredentialFingerprintResolver = Effect.fn(
  "makeAntigravityCredentialFingerprintResolver",
)(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  let cached:
    | { readonly tokenFingerprint: string; readonly accountFingerprint: string }
    | undefined;
  let generation = 0;

  const sha256 = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(
        Effect.map((digest) =>
          Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );

  const fetchJson = (request: HttpClientRequest.HttpClientRequest) =>
    httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
    );

  const resolve = Effect.fn("AntigravityCredentialFingerprint.resolve")(function* (
    tokenPath: string,
  ) {
    const startedGeneration = generation;
    const token = yield* fs
      .readFileString(tokenPath)
      .pipe(Effect.flatMap(decodeTokenFile), Effect.option);
    if (Option.isNone(token)) return undefined;
    const tokenFingerprintOption = yield* sha256(
      `${token.value.client_id}\0${token.value.refresh_token}`,
    ).pipe(Effect.option);
    if (Option.isNone(tokenFingerprintOption)) return undefined;
    const tokenFingerprint = tokenFingerprintOption.value;
    if (cached?.tokenFingerprint === tokenFingerprint) {
      return cached.accountFingerprint;
    }
    if (cached !== undefined) {
      cached = undefined;
    }
    const accountFingerprint = yield* fetchJson(
      HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: token.value.client_id,
          client_secret: token.value.client_secret,
          refresh_token: token.value.refresh_token,
          grant_type: "refresh_token",
        }),
      ),
    ).pipe(
      Effect.flatMap(decodeTokenResponse),
      Effect.flatMap((refreshed) =>
        fetchJson(
          HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
            HttpClientRequest.setHeaders({ Authorization: `Bearer ${refreshed.access_token}` }),
          ),
        ),
      ),
      Effect.flatMap(decodeUserInfo),
      Effect.flatMap((info) => sha256(`google-account\0${info.id}`)),
      Effect.option,
    );
    if (Option.isSome(accountFingerprint)) {
      if (generation === startedGeneration) {
        cached = { tokenFingerprint, accountFingerprint: accountFingerprint.value };
      }
      return accountFingerprint.value;
    }
    return tokenFingerprint;
  });

  const clear = Effect.sync(() => {
    generation += 1;
    cached = undefined;
  });

  return { resolve, clear };
});

type QuotaRuntime = Pick<
  AcpSessionRuntime["Service"],
  "getEvents" | "drainEvents" | "start" | "prompt"
>;

/** Only the advertised, built-in command on the qualified managed runtime bypasses model dispatch. */
export const readAntigravityAcpQuota = Effect.fn("readAntigravityAcpQuota")(function* (
  runtime: QuotaRuntime,
) {
  const commandsReady = yield* Deferred.make<"supported" | "unsupported" | "terminated">();
  let collecting = false;
  let report: string | undefined = "";
  yield* runtime.getEvents().pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event._tag === "EventStreamBarrier") {
          yield* Deferred.succeed(event.acknowledge, undefined);
        } else if (event._tag === "AvailableCommandsUpdated") {
          yield* Deferred.succeed(
            commandsReady,
            event.availableCommands.some((command) => command.name === "usage")
              ? "supported"
              : "unsupported",
          );
        } else if (event._tag === "ConnectionTerminated") {
          yield* Deferred.succeed(commandsReady, "terminated");
        } else if (collecting && event._tag === "ContentDelta" && report !== undefined) {
          report =
            report.length + event.text.length <= MAX_REPORT_LENGTH
              ? report + event.text
              : undefined;
        }
      }),
    ),
    Effect.ensuring(Deferred.succeed(commandsReady, "terminated")),
    Effect.forkScoped,
  );
  const started = yield* runtime.start();
  if (!supportsAntigravityAcpQuota(started.initializeResult.agentInfo?.version)) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return unavailableAntigravityLimits(checkedAt, "unsupported");
  }
  // Antigravity announces commands after session/new. The driver owns the probe timeout.
  const commands = yield* Deferred.await(commandsReady);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (commands === "terminated") {
    return unavailableAntigravityLimits(checkedAt, "probeFailed");
  }
  if (commands !== "supported") {
    return unavailableAntigravityLimits(checkedAt, "unsupported");
  }
  collecting = true;
  const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "/usage" }] });
  yield* runtime.drainEvents;
  return result.stopReason === "end_turn" && report !== undefined
    ? parseAntigravityUsageReport(report, checkedAt)
    : unavailableAntigravityLimits(checkedAt, "probeFailed");
}, Effect.scoped);
