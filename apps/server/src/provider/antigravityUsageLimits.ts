import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { AcpSessionRuntime } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isQualifiedAntigravityRelease } from "./acp/AntigravityAcpSupport.ts";

const MAX_REPORT_LENGTH = 64_000;

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
      : /\b5[ -]?(?:h|hours?)\b/i.test(bucket)
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

type QuotaRuntime = Pick<
  AcpSessionRuntime["Service"],
  "getEvents" | "drainEvents" | "start" | "prompt"
>;

/** Only the advertised, built-in command on the qualified managed runtime bypasses model dispatch. */
export const readAntigravityAcpQuota = Effect.fn("readAntigravityAcpQuota")(function* (
  runtime: QuotaRuntime,
) {
  let advertised = false;
  let report: string | undefined = "";
  yield* runtime.getEvents().pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event._tag === "EventStreamBarrier") {
          yield* Deferred.succeed(event.acknowledge, undefined);
        } else if (event._tag === "AvailableCommandsUpdated") {
          advertised = event.availableCommands.some((command) => command.name === "usage");
        } else if (event._tag === "ContentDelta" && report !== undefined) {
          report =
            report.length + event.text.length <= MAX_REPORT_LENGTH
              ? report + event.text
              : undefined;
        }
      }),
    ),
    Effect.forkScoped,
  );
  const started = yield* runtime.start();
  yield* runtime.drainEvents;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!isQualifiedAntigravityRelease(started.initializeResult.agentInfo?.version) || !advertised) {
    return unavailableAntigravityLimits(checkedAt, "unsupported");
  }
  const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "/usage" }] });
  yield* runtime.drainEvents;
  return result.stopReason === "end_turn" && report !== undefined
    ? parseAntigravityUsageReport(report, checkedAt)
    : unavailableAntigravityLimits(checkedAt, "probeFailed");
}, Effect.scoped);
