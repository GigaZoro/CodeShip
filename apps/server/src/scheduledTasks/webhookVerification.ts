import type { ScheduledTaskWebhookSignature } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";

const utf8 = (value: string) => new TextEncoder().encode(value);

/** The Standard Webhooks spec's tolerance between the signed timestamp and arrival. */
const STANDARD_WEBHOOKS_TOLERANCE_SECONDS = 5 * 60;

const STANDARD_WEBHOOKS_SECRET_PREFIX = "whsec_";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Compares hashes so the comparison does not leak either string's length. */
export const constantTimeEquals = Effect.fn("webhookVerification.constantTimeEquals")(function* (
  a: string,
  b: string,
) {
  const digest = yield* Digest.Digest;
  const [left, right] = yield* Effect.all([
    digest.digest(Digest.sha256, utf8(a)),
    digest.digest(Digest.sha256, utf8(b)),
  ]);
  return Mac.timingSafeEqual(left, right);
});

/** The HMAC key of a `whsec_` secret, or null when it is not base64. */
export function standardWebhooksKey(secret: string): Uint8Array | null {
  const encoded = secret.startsWith(STANDARD_WEBHOOKS_SECRET_PREFIX)
    ? secret.slice(STANDARD_WEBHOOKS_SECRET_PREFIX.length)
    : secret;
  if (encoded.length === 0 || !BASE64.test(encoded)) return null;
  const key = Base64.decode(encoded);
  return Result.isSuccess(key) ? key.success : null;
}

const verifyStandardWebhook = Effect.fn("webhookVerification.verifyStandardWebhook")(
  function* (input: {
    readonly secret: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly receivedAtMs: number;
  }) {
    const id = input.headers["webhook-id"]?.trim();
    const timestamp = input.headers["webhook-timestamp"]?.trim();
    const signatures = input.headers["webhook-signature"];
    if (!id || !timestamp || signatures === undefined || !/^\d+$/.test(timestamp)) return false;
    const skewSeconds = Math.abs(input.receivedAtMs / 1000 - Number(timestamp));
    if (skewSeconds > STANDARD_WEBHOOKS_TOLERANCE_SECONDS) return false;
    const keyBytes = standardWebhooksKey(input.secret);
    if (keyBytes === null) return false;
    const signed = utf8(`${id}.${timestamp}.`);
    const data = new Uint8Array(signed.length + input.body.length);
    data.set(signed);
    data.set(input.body, signed.length);
    const mac = yield* Mac.Mac;
    const expected = yield* Mac.key(Mac.hmacSha256, keyBytes).pipe(
      Effect.flatMap((key) => mac.sign(key, data)),
      Effect.orElseSucceed(() => null),
    );
    if (expected === null) return false;
    // Check every candidate so the time taken does not reveal which one matched.
    let matched = false;
    for (const entry of signatures.trim().split(/\s+/)) {
      const comma = entry.indexOf(",");
      if (comma === -1 || entry.slice(0, comma) !== "v1") continue;
      const candidate = Base64.decode(entry.slice(comma + 1));
      if (Result.isSuccess(candidate) && Mac.timingSafeEqual(candidate.success, expected)) {
        matched = true;
      }
    }
    return matched;
  },
);

export const verifyWebhookSignature = Effect.fn("webhookVerification.verifyWebhookSignature")(
  function* (input: {
    readonly signature: ScheduledTaskWebhookSignature;
    readonly secret: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    /** When the request reached CodeShip or the relay, in epoch milliseconds. */
    readonly receivedAtMs: number;
  }) {
    const signature = input.signature;
    if ("scheme" in signature) return yield* verifyStandardWebhook(input);
    const received = input.headers[signature.header.toLowerCase()];
    if (received === undefined) return false;
    const value = received.trim();
    const prefix = signature.prefix;
    if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
    const candidate = value.slice(prefix.length);
    const tag =
      signature.encoding === "hex" ? Hex.decode(candidate.toLowerCase()) : Base64.decode(candidate);
    if (Result.isFailure(tag)) return false;
    const mac = yield* Mac.Mac;
    return yield* Mac.key(Mac.hmacSha256, utf8(input.secret)).pipe(
      Effect.flatMap((key) => mac.verify(key, tag.success, input.body)),
      Effect.orElseSucceed(() => false),
    );
  },
);
