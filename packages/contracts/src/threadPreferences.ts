import * as Schema from "effect/Schema";

export const ThreadNotificationLevel = Schema.Literals(["default", "muted", "following"]);
export type ThreadNotificationLevel = typeof ThreadNotificationLevel.Type;

export const ThreadColor = Schema.Literals([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
]);
export type ThreadColor = typeof ThreadColor.Type;
