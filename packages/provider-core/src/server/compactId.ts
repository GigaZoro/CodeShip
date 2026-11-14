// Orchestration ids embed the ids they derive from. Escaping each embedded id again, ':' included,
// multiplied its length per level: a provider turn id was ~330 bytes, an event id ~320.
// `encodeIdPart` leaves ':' and '%' alone, so embedding an id stays additive.
const UNSAFE_ID_CHARACTERS = /[^A-Za-z0-9\-._~:%]+/g;

export const encodeIdPart = (part: string | number): string =>
  String(part).replace(UNSAFE_ID_CHARACTERS, encodeURIComponent);

// Kinds whose ids use `encodeIdPart`. Thread, provider thread and session, checkpoint, project,
// command and raw event ids are lookup keys stored outside these tables and keep their form.
const COMPACTED_ID_PREFIXES = [
  "node",
  "run",
  "run-attempt",
  "turn-item",
  "provider-turn",
  "message",
  "runtime-request",
  "plan",
] as const;

const LEGACY_ESCAPES = /%(?:3A|25)/i;
const EVENT_UUID_SUFFIX =
  /^event:.+:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const compactedIdToken = new RegExp(
  `"((?:event|${COMPACTED_ID_PREFIXES.join("|")}):[^"\\\\\\s]*)"`,
  "g",
);
const compactedIdPrefix = new RegExp(`^(?:event|${COMPACTED_ID_PREFIXES.join("|")}):`);

const unescapeNestedIds = (id: string): string => {
  let next = id;
  while (LEGACY_ESCAPES.test(next)) {
    next = next.replace(/%3A/gi, ":").replace(/%25/g, "%");
  }
  return next;
};

/** The compact form of an id stored before `encodeIdPart`; any other string comes back unchanged. */
export const compactLegacyId = (id: string): string => {
  if (!compactedIdPrefix.test(id)) return id;
  const event = EVENT_UUID_SUFFIX.exec(id);
  if (event !== null) return `event:${event[1]}`;
  return LEGACY_ESCAPES.test(id) ? unescapeNestedIds(id) : id;
};

/** Compacts every id string inside a JSON document without parsing it. */
export const compactLegacyIdsInJson = (json: string): string =>
  json.replace(compactedIdToken, (token, id: string) => `"${compactLegacyId(id)}"`);
