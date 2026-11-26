import type { UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

function claudeIdentity(key: string | null) {
  if (key === null) return undefined;
  const parts = /^([^:]*):([^:]*)(:advisor:\d+)?$/.exec(key);
  if (!parts || (!parts[1] && !parts[2])) return undefined;
  return {
    message: parts[1] ?? "",
    request: parts[2] ?? "",
    kind: parts[3] ? "advisor" : "executor",
  };
}

function tupleIdentity(key: string | null, provider: "pi" | "muse", size: number) {
  if (key === null) return undefined;
  try {
    const parts: unknown = JSON.parse(key);
    if (Array.isArray(parts) && parts.length === size && parts[0] === provider) {
      const id: unknown = parts[1];
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    return undefined;
  }
}

function piIdentity(record: UsageRecord) {
  const id = tupleIdentity(record.dedupeKey, "pi", 4);
  // The same native entry can gain a response model or use equivalent timestamp spelling.
  return id === undefined ? undefined : JSON.stringify([id, record.timestampMs]);
}

export function canRetainUsageRecord(
  record: UsageRecord,
): record is UsageRecord & { readonly dedupeKey: string } {
  switch (record.provider) {
    case "claude":
      return claudeIdentity(record.dedupeKey) !== undefined;
    case "pi":
      return piIdentity(record) !== undefined;
    case "muse":
      return tupleIdentity(record.dedupeKey, "muse", 2) !== undefined;
    default:
      // Codex deltas have no native IDs, and Grok reuses prompt IDs on resume.
      return false;
  }
}

export function makeUsageRetentionMatcher(
  provider: UsageProviderKind,
  current: Iterable<UsageRecord>,
) {
  const identities = new Set<string>();
  const ambiguous = new Set<string>();
  const claudeScope = (kind: string, field: string, sessionId: string | null) =>
    JSON.stringify([kind, field, sessionId]);
  const museScope = (record: UsageRecord) => JSON.stringify([record.sessionId, record.timestampMs]);

  function addClaudeAmbiguity(kind: string, field: string, session: string) {
    ambiguous.add(claudeScope(kind, field, session));
    ambiguous.add(claudeScope(kind, field, null));
  }

  function hasClaudeAmbiguity(kind: string, field: string, session: string) {
    return (
      ambiguous.has(claudeScope(kind, field, "")) ||
      ambiguous.has(claudeScope(kind, field, session || null))
    );
  }

  function add(record: UsageRecord) {
    if (record.provider !== provider) return;
    switch (provider) {
      case "claude": {
        const id = claudeIdentity(record.dedupeKey);
        if (id === undefined) {
          addClaudeAmbiguity("", "", record.sessionId);
          return;
        }
        if (id.message) identities.add(JSON.stringify([id.kind, "message", id.message]));
        if (id.request) identities.add(JSON.stringify([id.kind, "request", id.request]));
        // Two partial rows with disjoint ID fields give no way to compare those IDs.
        if (!id.request) addClaudeAmbiguity(id.kind, "message", record.sessionId);
        if (!id.message) addClaudeAmbiguity(id.kind, "request", record.sessionId);
        return;
      }
      case "pi": {
        const id = piIdentity(record);
        if (id !== undefined) identities.add(id);
        return;
      }
      case "muse": {
        const id = tupleIdentity(record.dedupeKey, "muse", 2);
        if (id !== undefined) identities.add(id);
        // An inference can gain or lose the source ID and fall back to its envelope ID.
        ambiguous.add(museScope(record));
      }
    }
  }

  function matches(record: UsageRecord) {
    if (record.provider !== provider) return false;
    switch (provider) {
      case "claude": {
        const id = claudeIdentity(record.dedupeKey);
        if (id === undefined) return false;
        const session = record.sessionId;
        return (
          hasClaudeAmbiguity("", "", session) ||
          (id.message !== "" && identities.has(JSON.stringify([id.kind, "message", id.message]))) ||
          (id.request !== "" && identities.has(JSON.stringify([id.kind, "request", id.request]))) ||
          (!id.message && hasClaudeAmbiguity(id.kind, "message", session)) ||
          (!id.request && hasClaudeAmbiguity(id.kind, "request", session))
        );
      }
      case "pi": {
        const id = piIdentity(record);
        return id !== undefined && identities.has(id);
      }
      case "muse": {
        const id = tupleIdentity(record.dedupeKey, "muse", 2);
        return (id !== undefined && identities.has(id)) || ambiguous.has(museScope(record));
      }
      default:
        return false;
    }
  }

  for (const record of current) add(record);
  return { add, matches };
}
