import { ReviewMaterialRead } from "@t3tools/contracts/orchestratorMcp";
import * as Schema from "effect/Schema";

const decodeRead = Schema.decodeUnknownSync(ReviewMaterialRead, { onExcessProperty: "error" });

interface AssignmentReadBroker {
  readonly allowedReads: ReadonlyArray<ReviewMaterialRead>;
  readonly read: (request: ReviewMaterialRead) => Promise<Uint8Array>;
  readonly record: (
    request: ReviewMaterialRead,
    receipt: { readonly byteLength: number; readonly sha256: string },
  ) => Promise<void>;
}

/** The evaluator supplies one assignment's pins and session-bound callbacks. Only read_material crosses into the provider. */
export function bindReviewMaterial({ allowedReads, read, record }: AssignmentReadBroker) {
  const pins = allowedReads.map((pin) => ({ ...decodeRead(pin) }));
  return {
    async read_material(input: unknown): Promise<string> {
      try {
        const request = decodeRead(input);
        const allowed = pins.some(
          (pin) =>
            pin.handle === request.handle && pin.side === request.side && pin.path === request.path,
        );
        if (!allowed) throw new Error("Read outside assignment.");
        const bytes = Buffer.from(await read(request));
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        await record(request, {
          byteLength: bytes.length,
          sha256: Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
        });
        return text;
      } catch {
        // Broker and validation errors may contain evaluator paths or private request fields.
        throw new Error("Material read unavailable.");
      }
    },
  };
}
