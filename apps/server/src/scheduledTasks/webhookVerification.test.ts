// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import { verifyWebhookSignature } from "./webhookVerification.ts";

const body = new TextEncoder().encode('{"action":"opened"}');
const secret = "shared-secret";
const hmac = () => NodeCrypto.createHmac("sha256", secret).update(body);

describe("verifyWebhookSignature", () => {
  const github = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" } as const;

  it("rejects a tampered body, a wrong secret, a missing header and a missing prefix", () => {
    const valid = `sha256=${hmac().digest("hex")}`;
    const tampered = new TextEncoder().encode('{"action":"closed"}');
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        receivedAtMs: 0,
        secret,
        headers: { "x-hub-signature-256": valid },
        body: tampered,
      }),
    );
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        receivedAtMs: 0,
        secret: "other",
        headers: { "x-hub-signature-256": valid },
        body,
      }),
    );
    assert.isFalse(
      verifyWebhookSignature({ signature: github, secret, headers: {}, body, receivedAtMs: 0 }),
    );
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        receivedAtMs: 0,
        secret,
        headers: { "x-hub-signature-256": hmac().digest("hex") },
        body,
      }),
    );
  });

  it("accepts a base64 signature without prefix", () => {
    assert.isTrue(
      verifyWebhookSignature({
        signature: { header: "X-Signature", encoding: "base64", prefix: "" },
        receivedAtMs: 0,
        secret,
        headers: { "x-signature": hmac().digest("base64") },
        body,
      }),
    );
  });
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

  it("accepts the test vector, among several signatures and within five minutes", () => {
    assert.isTrue(verify(headers));
    assert.isTrue(verify(headers, { secret: vector.secret.slice("whsec_".length) }));
    assert.isTrue(
      verify({
        ...headers,
        "webhook-signature": `v1,Zm9yZ2VkCg== v2,ignored ${vector.signature}`,
      }),
    );
    assert.isTrue(verify(headers, { receivedAtSeconds: Number(vector.timestamp) + 300 }));
    assert.isTrue(verify(headers, { receivedAtSeconds: Number(vector.timestamp) - 300 }));
  });

  it("refuses a forged, stale, future or missing signature", () => {
    assert.isFalse(
      verify({ ...headers, "webhook-signature": "v1,Zm9yZ2Vkc2lnbmF0dXJlZm9yZ2Vkc2lnbmF0dXJl" }),
    );
    assert.isFalse(verify({ ...headers, "webhook-id": "msg_other" }));
    assert.isFalse(verify(headers, { secret: "whsec_b3RoZXJzZWNyZXQ=" }));
    assert.isFalse(verify(headers, { receivedAtSeconds: Number(vector.timestamp) + 301 }));
    assert.isFalse(verify(headers, { receivedAtSeconds: Number(vector.timestamp) - 301 }));
    assert.isFalse(verify({ "webhook-id": vector.id, "webhook-timestamp": vector.timestamp }));
    assert.isFalse(
      verify({ ...headers, "webhook-signature": vector.signature.replace("v1,", "v1a,") }),
    );
    assert.isFalse(verify(headers, { secret: "whsec_not base64!" }));
  });
});
