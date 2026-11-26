import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import { ApnsDeliveryJobVerificationError, SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";

type QueueMessage = Pick<Cloudflare.Queues.Message<unknown>, "id" | "body" | "ack" | "retry">;
const decodeJob = Schema.decodeUnknownOption(SignedApnsDeliveryJob);
const isVerificationError = Schema.is(ApnsDeliveryJobVerificationError);

export const processMessage = Effect.fn("relay.apn_delivery_queue.process_message")(function* (
  message: QueueMessage,
) {
  const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
  return yield* deliveries.processSignedJob(message.body).pipe(
    Effect.matchEffect({
      onFailure: Effect.fnUntraced(function* (error) {
        if (isVerificationError(error)) {
          message.ack();
          yield* Effect.logWarning("APNs queue job is permanently invalid; dropping it", {
            messageId: message.id,
            errorTag: error._tag,
            disposition: "dropped",
          });
          return false;
        }
        // Cloudflare keeps the first ack or retry decision for each message.
        message.retry();
        yield* Effect.logWarning("APNs queue delivery failed; retrying message", {
          messageId: message.id,
          errorTag: error._tag,
        });
        return true;
      }),
      onSuccess: () =>
        Effect.sync(() => {
          message.ack();
          return false;
        }),
    }),
  );
});

export const processBatch = Effect.fn("relay.apn_delivery_queue.process_batch")(function* (
  stream: Stream.Stream<QueueMessage>,
) {
  const messages = yield* Stream.runCollect(stream);
  const groups = Arr.groupBy(messages, (message) => {
    const job = decodeJob(message.body);
    return Option.isSome(job)
      ? JSON.stringify([job.value.payload.target.userId, job.value.payload.target.deviceId])
      : "";
  });
  yield* Effect.forEach(
    Object.values(groups),
    (group) =>
      Effect.gen(function* () {
        let retryPrecedingJob = false;
        for (const message of group) {
          // Hold this device's later updates behind a retry while other devices keep sending.
          if (retryPrecedingJob) message.retry();
          else retryPrecedingJob = yield* processMessage(message);
        }
      }),
    { concurrency: 10, discard: true },
  );
});
