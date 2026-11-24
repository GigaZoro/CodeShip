import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import { isApnsDeliveryJobVerificationError } from "./apnsDeliveryJobs.ts";

export const processMessage = Effect.fn("relay.apn_delivery_queue.process_message")(function* (
  message: Cloudflare.Queues.Message<unknown>,
) {
  const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
  yield* deliveries.processSignedJob(message.body).pipe(
    Effect.matchEffect({
      // The enclosing operation owns the span for this inline handler.
      onFailure: Effect.fnUntraced(function* (error) {
        // A signed job that is malformed, forged or expired fails the same way on every retry.
        if (isApnsDeliveryJobVerificationError(error)) {
          message.ack();
          return yield* Effect.logWarning("APNs queue job is permanently invalid; dropping it", {
            messageId: message.id,
            errorTag: error._tag,
            disposition: "dropped",
          });
        }
        // Cloudflare keeps the first ack/retry decision; decide before Alchemy acknowledges the batch.
        message.retry();
        yield* Effect.logWarning("APNs queue delivery failed; retrying message", {
          messageId: message.id,
          errorTag: error._tag,
        });
      }),
      onSuccess: () => Effect.sync(() => message.ack()),
    }),
  );
});
