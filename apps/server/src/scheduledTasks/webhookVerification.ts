// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import type { ScheduledTaskWebhookSignature } from "@t3tools/contracts/scheduledTask";

/** The Standard Webhooks spec's tolerance between the signed timestamp and arrival. */
const STANDARD_WEBHOOKS_TOLERANCE_SECONDS = 5 * 60;

const STANDARD_WEBHOOKS_SECRET_PREFIX = "whsec_";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Constant-time string comparison that does not leak length through timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = NodeCrypto.createHash("sha256").update(a).digest();
  const digestB = NodeCrypto.createHash("sha256").update(b).digest();
  return NodeCrypto.timingSafeEqual(digestA, digestB);
}

/** The HMAC key of a `whsec_` secret, or null when it is not base64. */
export function standardWebhooksKey(secret: string): Buffer | null {
  const encoded = secret.startsWith(STANDARD_WEBHOOKS_SECRET_PREFIX)
    ? secret.slice(STANDARD_WEBHOOKS_SECRET_PREFIX.length)
    : secret;
  if (encoded.length === 0 || !BASE64.test(encoded)) return null;
  return Buffer.from(encoded, "base64");
}

export function verifyWebhookSignature(input: {
  readonly signature: ScheduledTaskWebhookSignature;
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** When the request reached CodeShip or the relay, in epoch milliseconds. */
  readonly receivedAtMs: number;
}): boolean {
  const signature = input.signature;
  if ("scheme" in signature) return verifyStandardWebhook(input);
  const received = input.headers[signature.header.toLowerCase()];
  if (received === undefined) return false;
  const value = received.trim();
  const prefix = signature.prefix;
  if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const digest = NodeCrypto.createHmac("sha256", input.secret).update(input.body).digest();
  const expected =
    signature.encoding === "hex" ? digest.toString("hex") : digest.toString("base64");
  const candidate = value.slice(prefix.length);
  return constantTimeEquals(
    signature.encoding === "hex" ? candidate.toLowerCase() : candidate,
    expected,
  );
}

function verifyStandardWebhook(input: {
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly receivedAtMs: number;
}): boolean {
  const id = input.headers["webhook-id"]?.trim();
  const timestamp = input.headers["webhook-timestamp"]?.trim();
  const signatures = input.headers["webhook-signature"];
  if (!id || !timestamp || signatures === undefined || !/^\d+$/.test(timestamp)) return false;
  const skewSeconds = Math.abs(input.receivedAtMs / 1000 - Number(timestamp));
  if (skewSeconds > STANDARD_WEBHOOKS_TOLERANCE_SECONDS) return false;
  const key = standardWebhooksKey(input.secret);
  if (key === null) return false;
  const expected = NodeCrypto.createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(input.body)
    .digest("base64");
  // Check every candidate so the time taken does not reveal which one matched.
  let matched = false;
  for (const entry of signatures.trim().split(/\s+/)) {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") continue;
    if (constantTimeEquals(entry.slice(comma + 1), expected)) matched = true;
  }
  return matched;
}
