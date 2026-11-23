import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as Schema from "effect/Schema";

const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export function originalDemandId(...key: string[]): string {
  return `demand:${hashTelemetryId(encodeKey(key))}`;
}
