import {
  CodexCreditSpending,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderCreditGrant,
  type ProviderCreditUse,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ProjectionStore from "./ProjectionStore.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const decodeGrant = Schema.decodeUnknownOption(CodexCreditSpending);

type GrantSettings = Pick<ServerSettingsValue, "providerInstances">;

/** What the user allowed this Codex account to spend of its prepaid credits, if anything. */
function creditGrant(
  settings: GrantSettings,
  instanceId: ProviderInstanceId,
): CodexCreditSpending | undefined {
  if (!Object.hasOwn(settings.providerInstances, instanceId)) return undefined;
  const instance = settings.providerInstances[instanceId];
  const config = instance?.config;
  if (instance?.driver !== CODEX_DRIVER || typeof config !== "object" || config === null)
    return undefined;
  if (!("spendCredits" in config)) return undefined;
  return Option.getOrUndefined(decodeGrant(config.spendCredits));
}

/** Every Codex account the user allowed to spend prepaid credits, with what they allowed. */
export function creditGrants(
  settings: GrantSettings,
): ReadonlyMap<ProviderInstanceId, CodexCreditSpending> {
  const grants = new Map<ProviderInstanceId, CodexCreditSpending>();
  for (const key of Object.keys(settings.providerInstances)) {
    const instanceId = ProviderInstanceId.make(key);
    const grant = creditGrant(settings, instanceId);
    if (grant !== undefined) grants.set(instanceId, grant);
  }
  return grants;
}

/** What spending prepaid credits is judged from for one piece of work. */
export interface CreditAccess {
  /** Credits counted against each allowed account; an account absent has no balance read yet. */
  readonly spent: ReadonlyMap<ProviderInstanceId, number>;
  /** The thread the work is for and the threads it was delegated from; empty when none asks. */
  readonly requesters: ReadonlyArray<ThreadId>;
}

/** Nothing counted and no thread asking, so no allowance applies and nothing spends credits. */
export const NO_CREDIT_ACCESS: CreditAccess = { spent: new Map(), requesters: [] };

export type CreditGrantState =
  | "granted"
  | Extract<ProviderCreditUse, "not_enabled" | "out_of_scope" | "cap_reached">;

/** Whether the user's allowance lets this work spend the account's prepaid credits, or why not. */
export function creditGrantState(
  settings: GrantSettings,
  instanceId: ProviderInstanceId,
  access: CreditAccess,
): CreditGrantState {
  const grant = creditGrant(settings, instanceId);
  if (grant === undefined) return "not_enabled";
  const scope = grant.threadIds;
  if (scope !== undefined && !access.requesters.some((threadId) => scope.includes(threadId)))
    return "out_of_scope";
  const spent = access.spent.get(instanceId);
  // Until a balance is counted from, nothing holds the cap, so nothing spends.
  return spent !== undefined && spent < grant.capCredits ? "granted" : "cap_reached";
}

/** The allowance a capability shows: its cap, what is counted against it, and its scope. */
export function creditGrantReport(
  grant: CodexCreditSpending,
  spent: number | undefined,
): ProviderCreditGrant {
  const spentCredits = spent ?? 0;
  return {
    capCredits: grant.capCredits,
    spentCredits,
    remainingCredits: Math.max(0, grant.capCredits - spentCredits),
    ...(grant.threadIds === undefined ? {} : { threadIds: grant.threadIds }),
  };
}

/** A delegate's delegate is still the requester's work; deeper chains are not followed. */
const MAX_DELEGATION_DEPTH = 16;

/**
 * The thread and the threads it was delegated from on this server, nearest first. Forks and side
 * chats are work of their own, and another environment names its threads itself, so an allowance
 * for their source does not reach them.
 */
export const requesterThreads = Effect.fn("PrepaidCreditSpend.requesters")(function* (
  getThreadShell: ProjectionStore.ProjectionStoreV2Shape["getThreadShell"],
  threadId: ThreadId,
) {
  const requesters: Array<ThreadId> = [threadId];
  let current = threadId;
  for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth++) {
    const shell = yield* getThreadShell(current);
    if (shell === null) break;
    const parent =
      shell.lineage.relationshipToParent === "subagent" ? shell.lineage.parentThreadId : null;
    if (parent === null || requesters.includes(parent)) break;
    requesters.push(parent);
    current = parent;
  }
  return requesters as ReadonlyArray<ThreadId>;
});

/**
 * A finite balance CodeShip can count spending against. An unlimited or unread one cannot be held
 * to a cap.
 */
function countableBalance(provider: ServerProvider): number | null {
  const credits = provider.usageLimits?.credits;
  if (credits === undefined || credits.unlimited || credits.balance === undefined) return null;
  const balance = Number(credits.balance);
  return Number.isFinite(balance) ? balance : null;
}

/**
 * How far each allowed account's balance has fallen since spending was allowed. It lives in SQLite
 * so a restart keeps counting from the last balance read, and outside the numbered migrations,
 * whose ids this fork cannot share with upstream.
 */
export const ensureCreditSpendTable = (sql: SqlClient.SqlClient) => sql`
  CREATE TABLE IF NOT EXISTS prepaid_credit_spend (
    instance_id TEXT PRIMARY KEY,
    account_key TEXT,
    last_balance REAL NOT NULL,
    spent_credits REAL NOT NULL
  )
`;

/** Forgets the count of every account the user no longer allows, so allowing it again starts at zero. */
export const forgetUngrantedSpend = Effect.fn("PrepaidCreditSpend.forget")(function* (
  sql: SqlClient.SqlClient,
  settings: GrantSettings,
) {
  const granted = [...creditGrants(settings).keys()];
  yield* granted.length === 0
    ? sql`DELETE FROM prepaid_credit_spend`
    : sql`DELETE FROM prepaid_credit_spend WHERE instance_id NOT IN ${sql.in(granted)}`;
});

/**
 * Counts each fall in an allowed account's balance, from any use of the account. A rise (a top-up,
 * or a reading older than the last) counts nothing, so a reading out of order can count a fall
 * twice but never less than was spent. Each reading is one statement, so two writers that see the
 * same reading count it once.
 */
export const recordCreditBalances = Effect.fn("PrepaidCreditSpend.record")(function* (
  sql: SqlClient.SqlClient,
  providers: ReadonlyArray<ServerProvider>,
  settings: GrantSettings,
) {
  for (const provider of providers) {
    if (creditGrant(settings, provider.instanceId) === undefined) continue;
    const balance = countableBalance(provider);
    if (balance === null) continue;
    const accountKey = provider.usageLimits?.accountKey ?? null;
    // Another login on the same account entry has a balance of its own: count from its first one.
    yield* sql`
      INSERT INTO prepaid_credit_spend (instance_id, account_key, last_balance, spent_credits)
      VALUES (${provider.instanceId}, ${accountKey}, ${balance}, 0)
      ON CONFLICT (instance_id) DO UPDATE SET
        spent_credits = CASE
          WHEN account_key IS NOT NULL
            AND excluded.account_key IS NOT NULL
            AND account_key <> excluded.account_key
          THEN spent_credits
          ELSE spent_credits + MAX(0, last_balance - excluded.last_balance)
        END,
        last_balance = excluded.last_balance,
        account_key = COALESCE(excluded.account_key, account_key)
    `;
  }
});

/** Credits counted against each allowed account; an account absent has no balance read yet. */
export const readCreditSpend = Effect.fn("PrepaidCreditSpend.read")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<{
    readonly instance_id: string;
    readonly spent_credits: number;
  }>`SELECT instance_id, spent_credits FROM prepaid_credit_spend`;
  return new Map<ProviderInstanceId, number>(
    rows.map((row) => [ProviderInstanceId.make(row.instance_id), row.spent_credits]),
  ) as ReadonlyMap<ProviderInstanceId, number>;
});
