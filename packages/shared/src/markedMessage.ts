import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { interpolateMessage, t, type Message, type MessageValues } from "./i18n.ts";

const decodeOptions = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Keep the released wire format: rendered English, a colon, and UTF-8 base64 message metadata. */
export function markMessage(source: Message, values: MessageValues): string {
  const english = interpolateMessage(source, values);
  // Legacy clients look up the first 16 hex digits of the sorted ICU source descriptor's SHA-256.
  const descriptor = JSON.stringify({ dataFormat: "ICU", source });
  const hash = bytesToHex(sha256(utf8ToBytes(descriptor))).slice(0, 16);
  return `${english}:${Base64.encode(JSON.stringify({ ...values, $_source: source, $_hash: hash }))}`;
}

export function readMarkedMessage(sentence: string) {
  const separator = sentence.lastIndexOf(":");
  if (separator < 0) return null;
  const json = Result.getOrNull(Base64.decodeString(sentence.slice(separator + 1)));
  if (json === null) return null;
  const options = Option.getOrNull(decodeOptions(json));
  if (typeof options?.$_source !== "string" || typeof options.$_hash !== "string") return null;
  return { english: sentence.slice(0, separator), source: options.$_source, options };
}

/** Resolve plain and interpolated keys at display time, including messages from older peers. */
export function resolveMarkedMessage(sentence: string, resolve: typeof t = t): string {
  const marked = readMarkedMessage(sentence);
  if (!marked) return resolve(sentence as Message);
  const { english, source, options } = marked;
  if (options.$format === "STRING") return resolve(source as Message);
  // A legacy ICU choice, number, or quoted literal already has its rendered English on the wire.
  if (/[{}]/.test(source.replace(/\{\w+\}/g, "")) || /''|'[{}#]/.test(source)) return english;
  const values = Object.fromEntries(
    Object.entries(options).filter(
      (entry): entry is [string, string | number] =>
        !entry[0].startsWith("$") && (typeof entry[1] === "string" || typeof entry[1] === "number"),
    ),
  );
  return resolve(source as Message, values);
}
