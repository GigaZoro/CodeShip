import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

import * as FcmDeliveries from "./FcmDeliveries.ts";

export const processMessage = Effect.fn("relay.fcm_delivery_queue.process_message")(function* (
  message: Cloudflare.Queues.Message<unknown>,
) {
  const deliveries = yield* FcmDeliveries.FcmDeliveries;
  yield* deliveries.process(message.body).pipe(
    Effect.matchEffect({
      // The enclosing operation owns the span for this inline handler.
      onFailure: Effect.fnUntraced(function* (error) {
        // A job that does not decode fails the same way on every retry.
        if (error._tag === "FcmDeliveryError" && error.operation === "decode-job") {
          message.ack();
          return yield* Effect.logWarning("FCM queue job is permanently invalid; dropping it", {
            messageId: message.id,
            errorTag: error._tag,
            disposition: "dropped",
          });
        }
        // Cloudflare keeps the first ack/retry decision; decide before Alchemy acknowledges the batch.
        message.retry();
        yield* Effect.logWarning("FCM queue delivery failed; retrying message", {
          messageId: message.id,
          errorTag: error._tag,
        });
      }),
      onSuccess: () => Effect.sync(() => message.ack()),
    }),
  );
});
