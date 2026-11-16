// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's HMAC is an independent oracle for the Effect implementation.
import * as NodeCrypto from "node:crypto";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { verifyWebhookSignature } from "./webhookVerification.ts";

const body = new TextEncoder().encode('{"action":"opened"}');
const secret = "shared-secret";
const hmac = () => NodeCrypto.createHmac("sha256", secret).update(body);

describe("verifyWebhookSignature", () => {
  const github = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" } as const;

  it.effect("rejects a tampered body, a wrong secret, a missing header and a missing prefix", () =>
    Effect.gen(function* () {
      const valid = `sha256=${hmac().digest("hex")}`;
      const tampered = new TextEncoder().encode('{"action":"closed"}');
      assert.isFalse(
        yield* verifyWebhookSignature({
          signature: github,
          receivedAtMs: 0,
          secret,
          headers: { "x-hub-signature-256": valid },
          body: tampered,
        }),
      );
      assert.isFalse(
        yield* verifyWebhookSignature({
          signature: github,
          receivedAtMs: 0,
          secret: "other",
          headers: { "x-hub-signature-256": valid },
          body,
        }),
      );
      assert.isFalse(
        yield* verifyWebhookSignature({
          signature: github,
          secret,
          headers: {},
          body,
          receivedAtMs: 0,
        }),
      );
      assert.isFalse(
        yield* verifyWebhookSignature({
          signature: github,
          receivedAtMs: 0,
          secret,
          headers: { "x-hub-signature-256": hmac().digest("hex") },
          body,
        }),
      );
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );

  it.effect("accepts a hex signature with its prefix and a base64 signature without one", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* verifyWebhookSignature({
          signature: github,
          receivedAtMs: 0,
          secret,
          headers: { "x-hub-signature-256": `sha256=${hmac().digest("hex").toUpperCase()}` },
          body,
        }),
      );
      assert.isTrue(
        yield* verifyWebhookSignature({
          signature: { header: "X-Signature", encoding: "base64", prefix: "" },
          receivedAtMs: 0,
          secret,
          headers: { "x-signature": hmac().digest("base64") },
          body,
        }),
      );
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );
});

// The published Standard Webhooks test vector.
const vector = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: new TextEncoder().encode('{"test": 2432232314}'),
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

describe("verifyWebhookSignature with Standard Webhooks", () => {
  const verify = (
    headers: Readonly<Record<string, string>>,
    overrides: { readonly secret?: string; readonly receivedAtSeconds?: number } = {},
  ) =>
    verifyWebhookSignature({
      signature: { scheme: "standard-webhooks" },
      secret: overrides.secret ?? vector.secret,
      headers,
      body: vector.body,
      receivedAtMs: (overrides.receivedAtSeconds ?? Number(vector.timestamp)) * 1000,
    });
  const headers = {
    "webhook-id": vector.id,
    "webhook-timestamp": vector.timestamp,
    "webhook-signature": vector.signature,
  };

  it.effect("accepts the test vector, among several signatures and within five minutes", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* verify(headers));
      assert.isTrue(yield* verify(headers, { secret: vector.secret.slice("whsec_".length) }));
      assert.isTrue(
        yield* verify({
          ...headers,
          "webhook-signature": `v1,Zm9yZ2VkCg== v2,ignored ${vector.signature}`,
        }),
      );
      assert.isTrue(yield* verify(headers, { receivedAtSeconds: Number(vector.timestamp) + 300 }));
      assert.isTrue(yield* verify(headers, { receivedAtSeconds: Number(vector.timestamp) - 300 }));
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );

  it.effect("refuses a forged, stale, future or missing signature", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* verify({
          ...headers,
          "webhook-signature": "v1,Zm9yZ2Vkc2lnbmF0dXJlZm9yZ2Vkc2lnbmF0dXJl",
        }),
      );
      assert.isFalse(yield* verify({ ...headers, "webhook-id": "msg_other" }));
      assert.isFalse(yield* verify(headers, { secret: "whsec_b3RoZXJzZWNyZXQ=" }));
      assert.isFalse(yield* verify(headers, { receivedAtSeconds: Number(vector.timestamp) + 301 }));
      assert.isFalse(yield* verify(headers, { receivedAtSeconds: Number(vector.timestamp) - 301 }));
      assert.isFalse(
        yield* verify({ "webhook-id": vector.id, "webhook-timestamp": vector.timestamp }),
      );
      assert.isFalse(
        yield* verify({ ...headers, "webhook-signature": vector.signature.replace("v1,", "v1a,") }),
      );
      assert.isFalse(yield* verify(headers, { secret: "whsec_not base64!" }));
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );
});
