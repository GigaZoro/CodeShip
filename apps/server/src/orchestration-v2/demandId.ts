import { hashTelemetryId } from "@t3tools/shared/telemetryId";

export function originalDemandId(
  kind: "message" | "occurrence" | "work-item",
  ...ids: string[]
): string {
  const key = [kind, ...ids].map((part) => `${Buffer.byteLength(part)}:${part}`).join("");
  return `demand:${hashTelemetryId(key)}`;
}
