import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Claude renews an MCP access token only in its last five minutes. Starting inside that window keeps
// the old token valid while Claude renews it, so the account's other chats never renew an expired one
// on a 401, which Claude does without its lock, retiring a refresh token another chat just used.
const RENEW_LEAD_MS = 4 * 60_000;
// Also bounds how late a renewal starts after the machine wakes.
const CHECK_INTERVAL_MS = 60_000;
const MIN_RENEW_INTERVAL_MS = 60_000;
const RETRY_AFTER_EXPIRY_MS = 15 * 60_000;
const PROCESS_START_WAIT = Duration.seconds(30);

/** A remote MCP server Claude is signed in to and can renew: no token values. */
export interface ClaudeMcpSignIn {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly expiresAt: number;
}

const McpOAuthRecord = Schema.Struct({
  serverName: Schema.optional(Schema.String),
  serverUrl: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
});
const decodeMcpOAuthRecord = Schema.decodeUnknownOption(McpOAuthRecord);
const decodeMcpCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ mcpOAuth: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
);

/** The MCP sign-ins in a Claude credentials document that still hold a refresh token. */
export const parseClaudeMcpSignIns = (document: string): ReadonlyArray<ClaudeMcpSignIn> =>
  Object.values(Option.getOrUndefined(decodeMcpCredentials(document))?.mcpOAuth ?? {}).flatMap(
    (value) => {
      const record = Option.getOrUndefined(decodeMcpOAuthRecord(value));
      const expiresAt = record?.expiresAt;
      if (!record?.serverName || !record.serverUrl || !record.refreshToken) return [];
      if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= 0) return [];
      return [{ serverName: record.serverName, serverUrl: record.serverUrl, expiresAt }];
    },
  );

/** The URL of each MCP server in a Claude config that has one, by name. */
export const claudeRemoteMcpServerUrls = (
  servers: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(servers).flatMap(([name, server]) => {
      const url =
        typeof server === "object" && server !== null && "url" in server ? server.url : undefined;
      return typeof url === "string" ? [[name, url] as const] : [];
    }),
  );

export interface ClaudeMcpRenewalAttempt {
  /** The expiry the sign-in had when the renewal started; unchanged afterwards means it failed. */
  readonly expiresAt: number;
  readonly at: number;
}

/** The servers to renew now, and when to look again. */
export const planClaudeMcpRenewals = (input: {
  readonly signIns: ReadonlyArray<ClaudeMcpSignIn>;
  /** Sign-ins kept for a server since removed or moved to another URL are left alone. */
  readonly configured: ReadonlyMap<string, string>;
  readonly attempts: ReadonlyMap<string, ClaudeMcpRenewalAttempt>;
  readonly nowMs: number;
}): { readonly due: ReadonlyArray<ClaudeMcpSignIn>; readonly nextCheckAt: number } => {
  // Claude keeps one record per server name, URL and headers; after a header change the older
  // record stays behind, and the newest is the one Claude renews.
  const current = new Map<string, ClaudeMcpSignIn>();
  for (const signIn of input.signIns) {
    if (input.configured.get(signIn.serverName) !== signIn.serverUrl) continue;
    const seen = current.get(signIn.serverName);
    if (seen === undefined || signIn.expiresAt > seen.expiresAt) {
      current.set(signIn.serverName, signIn);
    }
  }
  const due: Array<ClaudeMcpSignIn> = [];
  let nextCheckAt = input.nowMs + CHECK_INTERVAL_MS;
  for (const signIn of current.values()) {
    const attempt = input.attempts.get(signIn.serverName);
    const failedAfterExpiry =
      attempt?.expiresAt === signIn.expiresAt && input.nowMs >= signIn.expiresAt;
    const dueAt = Math.max(
      signIn.expiresAt - RENEW_LEAD_MS,
      attempt === undefined
        ? 0
        : attempt.at + (failedAfterExpiry ? RETRY_AFTER_EXPIRY_MS : MIN_RENEW_INTERVAL_MS),
    );
    if (dueAt <= input.nowMs) due.push(signIn);
    else nextCheckAt = Math.min(nextCheckAt, dueAt);
  }
  return { due, nextCheckAt };
};

export interface ClaudeMcpSignInRenewal {
  /**
   * Renews any sign-in that has expired or is about to, and waits for it (30 s at most), so a new
   * Claude process does not start holding an expired token alongside the account's other chats.
   */
  readonly ensureFresh: Effect.Effect<void>;
}

// Renewals outlive a provider instance, and a rebuilt one must join a renewal still running instead
// of starting a second, so who renews what lives per credential store for the server's lifetime.
interface RenewalStore {
  signIns: ReadonlyArray<ClaudeMcpSignIn>;
  configured: ReadonlyMap<string, string>;
  readonly attempts: Map<string, ClaudeMcpRenewalAttempt>;
  readonly renewing: Map<string, Deferred.Deferred<void>>;
}
const stores = new Map<string, RenewalStore>();

/**
 * Keeps one Claude account's MCP sign-ins renewed before their access tokens expire, by having
 * Claude renew each one (`renew`) with its own code and lock, until the scope closes.
 */
export const makeClaudeMcpSignInRenewal = Effect.fn("makeClaudeMcpSignInRenewal")(function* <
  R,
>(options: {
  /** The account's credential store, such as its Claude config folder. */
  readonly storeKey: string;
  readonly readSignIns: Effect.Effect<ReadonlyArray<ClaudeMcpSignIn>, never, R>;
  readonly readConfigured: Effect.Effect<ReadonlyMap<string, string>, never, R>;
  readonly renew: (serverName: string) => Effect.Effect<void, never, R>;
}) {
  const context = yield* Effect.context<R>();
  const store: RenewalStore = stores.get(options.storeKey) ?? {
    signIns: [],
    configured: new Map(),
    attempts: new Map(),
    renewing: new Map(),
  };
  stores.set(options.storeKey, store);
  const { attempts, renewing } = store;

  const refresh = Effect.all([options.readSignIns, options.readConfigured]).pipe(
    Effect.tap(([read, servers]) =>
      Effect.sync(() => {
        store.signIns = read;
        store.configured = servers;
      }),
    ),
    Effect.provideContext(context),
  );
  const logDefect = (defect: unknown) =>
    Effect.logWarning("Renewing Claude's MCP sign-ins failed; trying again.", { defect });

  // Stopping Claude between the server's answer and its save would lose the rotated refresh token,
  // so a renewal runs detached from whoever started it. Claiming and forking are one step, or a
  // chat cancelled between them would leave a claim nobody finishes.
  const start = (signIn: ClaudeMcpSignIn, nowMs: number) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (renewing.has(signIn.serverName)) return;
        const done = Deferred.makeUnsafe<void, never>();
        renewing.set(signIn.serverName, done);
        attempts.set(signIn.serverName, { expiresAt: signIn.expiresAt, at: nowMs });
        yield* options
          .renew(signIn.serverName)
          .pipe(
            Effect.andThen(refresh),
            Effect.catchDefect(logDefect),
            Effect.ensuring(
              Effect.sync(() => renewing.delete(signIn.serverName)).pipe(
                Effect.andThen(Deferred.succeed(done, undefined)),
              ),
            ),
            Effect.provideContext(context),
            Effect.forkDetach,
          );
      }),
    );

  const startDue = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const plan = planClaudeMcpRenewals({ ...store, nowMs });
    yield* Effect.forEach(plan.due, (signIn) => start(signIn, nowMs), { discard: true });
    return plan.nextCheckAt - nowMs;
  });

  yield* refresh.pipe(Effect.catchDefect(logDefect));
  yield* Effect.gen(function* () {
    while (true) {
      const delayMs = yield* startDue.pipe(
        Effect.catchDefect((defect) => logDefect(defect).pipe(Effect.as(CHECK_INTERVAL_MS))),
      );
      yield* Effect.sleep(Duration.millis(delayMs));
      yield* refresh.pipe(Effect.catchDefect(logDefect));
    }
  }).pipe(Effect.forkScoped);

  const ensureFresh = Effect.gen(function* () {
    yield* startDue;
    yield* Effect.forEach([...renewing.values()], (done) => Deferred.await(done), {
      concurrency: "unbounded",
      discard: true,
    });
  }).pipe(Effect.timeout(PROCESS_START_WAIT), Effect.ignore, Effect.catchDefect(logDefect));

  return { ensureFresh } satisfies ClaudeMcpSignInRenewal;
});
