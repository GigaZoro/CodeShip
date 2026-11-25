import type {
  ServerProviderResetCreditOption,
  ServerProviderResetCredits,
  ServerProviderResetCreditsError,
  ServerProviderResetKind,
  ServerProviderResetPrograms,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { usageAccountKey } from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  claimClaudeGrantedReset,
  claimClaudeWeeklySessionReset,
  ClaudeLimitResetError,
  readClaudeLimitResets,
  type ClaudeLimitResetPrograms,
  type ClaudeLimitResetTerminalOptions,
} from "./claudeLimitResetTerminal.ts";
import {
  GRANTED_TEXTS,
  RESET_KINDS,
  WEEKLY_SESSION_TEXTS,
  withTextOverrides,
  type ClaudeClaimAnswer,
  type ClaudeLimitResetGrant,
  type ClaudeUsableGrant,
  type GrantedTexts,
} from "./claudeLimitResetText.ts";
import { ResetCreditCoordinator } from "./resetCreditCoordinator.ts";

const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      organizationUuid: Schema.optional(Schema.String),
      accountUuid: Schema.optional(Schema.Unknown),
    }),
  ),
});
const FlagsConfig = Schema.Struct({
  cachedGrowthBookFeatures: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/** Claude's flags for banked grants and for the weekly 5-hour reset, as it caches them. */
const GRANTED_FLAG = "tengu_cedar_ember";
const WEEKLY_SESSION_FLAG = "tengu_nifty_lemur";
const GRANTED_PROGRAM = "cedar_ember";
/** Grants change only when Anthropic hands out or expires one, or when one is used. */
const READ_INTERVAL = Duration.toMillis(Duration.hours(6));
/** A failed read is retried after this, doubling while it keeps failing, up to `READ_INTERVAL`. */
const FAILED_READ_RETRY = Duration.toMillis(Duration.minutes(10));

const readJson = Effect.fn("claudeResetCredits.readJson")(function* <S extends Schema.Top>(
  schema: S,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
  );
});

export interface ClaudeAccountIdentity {
  readonly workspaceId?: string;
  /** `usageAccountKey` of the account id; the id itself never leaves this read. */
  readonly accountKey?: string;
}

/** The `oauthAccount` block `.claude.json` holds; undefined when it has none or cannot be read. */
export const readClaudeOauthAccount = (accountConfigPath: string) =>
  readJson(Config, accountConfigPath).pipe(
    Effect.map((config) => config.oauthAccount),
    Effect.orElseSucceed(() => undefined),
  );

/** The signed-in account `.claude.json` names; empty when it names none or cannot be read. */
export const readClaudeAccountIdentity = (accountConfigPath: string) =>
  readClaudeOauthAccount(accountConfigPath).pipe(
    Effect.map((account): ClaudeAccountIdentity => {
      const workspaceId = account?.organizationUuid?.trim();
      const accountKey = usageAccountKey(
        typeof account?.accountUuid === "string" ? account.accountUuid : undefined,
      );
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(accountKey ? { accountKey } : {}),
      };
    }),
  );

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});

/** A flag counts only as Claude reads it: an object whose `enabled` is true. */
const enabledFlag = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { readonly enabled?: unknown }).enabled === true
    ? value
    : undefined;

/**
 * The reset programs the account's cached flags turn on, with the texts Claude shows for each. A
 * missing config turns none on; one that cannot be read fails, so it never reads as "off".
 */
export const readClaudeLimitResetPrograms = (accountConfigPath: string) =>
  readJson(FlagsConfig, accountConfigPath).pipe(
    Effect.map((config): ClaudeLimitResetPrograms => {
      const features = config.cachedGrowthBookFeatures ?? {};
      const granted = enabledFlag(features[GRANTED_FLAG]);
      const weeklySession = enabledFlag(features[WEEKLY_SESSION_FLAG]);
      return {
        ...(granted ? { granted: withTextOverrides(GRANTED_TEXTS, granted) } : {}),
        ...(weeklySession
          ? { weeklySession: withTextOverrides(WEEKLY_SESSION_TEXTS, weeklySession) }
          : {}),
      };
    }),
    // A parse error can quote the config, which holds the account's e-mail, so only file errors
    // go along as the cause.
    Effect.mapError(
      (cause) =>
        new ClaudeLimitResetError({
          reason: "readFailed",
          ...(cause._tag === "PlatformError" ? { cause } : {}),
        }),
    ),
  );

/** The reset fields of one usage read. */
export interface ClaudeLimitResetFields {
  readonly resetCredits?: ServerProviderResetCredits;
  readonly resetCreditsError?: ServerProviderResetCreditsError;
  /** Absent when the account's config could not be read. */
  readonly resetPrograms?: ServerProviderResetPrograms;
}

export interface ClaudeLimitResetReadState {
  readonly reading?: {
    readonly at: number;
    /** The account the grants belong to; usage of another account does not show them. */
    readonly accountKey?: string;
    /** The login's redemption count at the read; a later redemption may have changed the grants. */
    readonly redemptions: number;
    readonly grants: ReadonlyArray<ClaudeLimitResetGrant>;
  };
  readonly failure?: {
    readonly at: number;
    readonly reason: ServerProviderResetCreditsError;
    readonly attempts: number;
    readonly redemptions: number;
  };
  /** Whether the last usage seen was at a limit, so the next read waits for the next limit. */
  readonly limited: boolean;
  /** `checkedAt` of the newest usage seen; older usage that arrives late changes nothing. */
  readonly usageCheckedAt?: number;
  readonly weeklySessionAvailableAt?: string;
}

/** What the usage being published says, and how many redemptions its login has seen. */
export interface ClaudeLimitResetUsage {
  readonly now: number;
  readonly limited: boolean;
  readonly accountKey?: string;
  readonly redemptions: number;
}

const isAtLimit = (usageLimits: ServerProviderUsageLimits) =>
  usageLimits.usageAllowed === false ||
  usageLimits.windows.some((window) => window.usedPercent >= 100);

const FAILURE_REASONS = {
  signedOut: "signedOut",
  unrecognizedScreen: "unrecognizedScreen",
  programChanged: "unrecognizedScreen",
  readFailed: "readFailed",
  lowPriority: "lowPriority",
  unavailable: "readFailed",
  accountChanged: "readFailed",
  unconfirmed: "readFailed",
} as const satisfies Record<ClaudeLimitResetError["reason"], ServerProviderResetCreditsError>;

/** `state` once `usageLimits` is seen; unread usage, or older than the newest seen, changes nothing. */
export function withUsage(
  state: ClaudeLimitResetReadState,
  usageLimits: ServerProviderUsageLimits,
): ClaudeLimitResetReadState {
  if (usageLimits.unavailable !== undefined) return state;
  const checkedAt = Date.parse(usageLimits.checkedAt);
  if (state.usageCheckedAt !== undefined && checkedAt < state.usageCheckedAt) return state;
  return { ...state, limited: isAtLimit(usageLimits), usageCheckedAt: checkedAt };
}

/** Whether `reading` still describes the account `usage` belongs to. */
const describes = (
  reading: NonNullable<ClaudeLimitResetReadState["reading"]>,
  usage: Pick<ClaudeLimitResetUsage, "accountKey" | "redemptions">,
) => reading.redemptions === usage.redemptions && reading.accountKey === usage.accountKey;

/**
 * Whether the grants are due for another read: the first time, six hours after the last, when the
 * account newly reaches a limit, after any redemption on its login, after a failure once its
 * backoff has passed, and for another account no sooner than a failed read would be retried.
 */
export function isLimitResetReadDue(
  state: ClaudeLimitResetReadState,
  usage: ClaudeLimitResetUsage,
): boolean {
  if (state.failure !== undefined) {
    if (state.failure.redemptions !== usage.redemptions) return true;
    const backoff = FAILED_READ_RETRY * 2 ** (state.failure.attempts - 1);
    return usage.now - state.failure.at >= Math.min(backoff, READ_INTERVAL);
  }
  if (state.reading === undefined || state.reading.redemptions !== usage.redemptions) return true;
  const age = usage.now - state.reading.at;
  return (
    age >= READ_INTERVAL ||
    (usage.limited && !state.limited) ||
    (state.reading.accountKey !== usage.accountKey && age >= FAILED_READ_RETRY)
  );
}

const usableGrants = (grants: ReadonlyArray<ClaudeLimitResetGrant>) =>
  grants.filter((grant): grant is ClaudeUsableGrant => grant.usableNow);

// Claude Code's own wording for what each kind of grant refills.
const RESET_OPTION_TEXTS: Record<
  ServerProviderResetKind,
  Pick<ServerProviderResetCreditOption, "label" | "description">
> = {
  five_hour: { label: "5-hour reset", description: "Refills your 5-hour limit." },
  weekly: { label: "Weekly reset", description: "Refills your weekly limit." },
  fable: {
    label: "Fable reset",
    description:
      "Refills your Fable allowance and gives back what Fable used on your weekly limit. It doesn't reset your whole week.",
  },
  full: { label: "Full reset", description: "Refills your 5-hour and weekly limits." },
};
const OPTION_ORDER: ReadonlyArray<ServerProviderResetKind> = [
  "five_hour",
  "weekly",
  "fable",
  "full",
];

const earliestExpiry = (grants: ReadonlyArray<ClaudeLimitResetGrant>) =>
  grants
    .flatMap((grant) =>
      "expiresAt" in grant && grant.expiresAt !== undefined ? [grant.expiresAt] : [],
    )
    .toSorted()[0];

/** One option per kind of usable grant; its `creditId` is the kind, which a claim names. */
function toResetOptions(
  usable: ReadonlyArray<ClaudeUsableGrant>,
): Array<ServerProviderResetCreditOption> {
  return OPTION_ORDER.flatMap((kind) => {
    const grants = usable.filter((grant) => grant.kind === kind && grant.resetsLeft > 0);
    if (grants.length === 0) return [];
    const expiresAt = earliestExpiry(grants);
    return [
      {
        creditId: kind,
        ...RESET_OPTION_TEXTS[kind],
        availableCount: grants.reduce((sum, grant) => sum + grant.resetsLeft, 0),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    ];
  });
}

/** The kind of grant the option `creditId` names, while `resetCredits` still offers it. */
export function offeredResetKind(
  resetCredits: ServerProviderResetCredits | undefined,
  creditId: string,
): ServerProviderResetKind | undefined {
  if (!resetCredits?.options?.some((option) => option.creditId === creditId)) return undefined;
  return RESET_KINDS.find((kind) => kind === creditId);
}

function toResetCredits(grants: ReadonlyArray<ClaudeLimitResetGrant>): ServerProviderResetCredits {
  const usable = usableGrants(grants);
  const nextExpiresAt = earliestExpiry(usable);
  const options = toResetOptions(usable);
  return {
    availableCount: usable.reduce((sum, grant) => sum + grant.resetsLeft, 0),
    ...(nextExpiresAt === undefined ? {} : { nextExpiresAt }),
    credits: grants.map((grant) => ({ program: GRANTED_PROGRAM, ...grant })),
    ...(options.length === 0 ? {} : { options }),
  };
}

/** The usable grant Claude should spend first: the one that expires first. */
function firstToExpire(grants: ReadonlyArray<ClaudeLimitResetGrant>) {
  return usableGrants(grants).toSorted((a, b) =>
    (a.expiresAt ?? "\uffff").localeCompare(b.expiresAt ?? "\uffff"),
  )[0]?.kind;
}

export interface ClaudeLimitResetsOptions {
  readonly accountConfigPath: string;
  /** The login's folder: instances sharing it share its grants and one lock on its terminal. */
  readonly loginKey: string;
  readonly terminal: Omit<ClaudeLimitResetTerminalOptions, "programs">;
  /** Publishes a finished read; the next usage read picks it up. */
  readonly onRead: Effect.Effect<void>;
}

/**
 * One account's Claude limit resets: reads them in a hidden terminal at most every six hours and
 * again when the account reaches a limit or a reset was used, and uses one only when asked. Reads
 * and claims of every instance on the same login take turns on the reset coordinator's lock.
 */
export const makeClaudeLimitResets = Effect.fn("makeClaudeLimitResets")(function* (
  options: ClaudeLimitResetsOptions,
) {
  const scope = yield* Scope.Scope;
  // Reads and claims run with the driver's services (its PTY adapter), whoever asks for them.
  const context = yield* Effect.context<never>();
  const coordinator = yield* ResetCreditCoordinator;
  const state = yield* Ref.make<ClaudeLimitResetReadState>({ limited: false });
  const fs = yield* FileSystem.FileSystem;
  const programs = readClaudeLimitResetPrograms(options.accountConfigPath).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const accountKey = readClaudeAccountIdentity(options.accountConfigPath).pipe(
    Effect.map((identity) => identity.accountKey),
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const redemptions = coordinator.redemptions(options.loginKey);
  const terminalOptions: ClaudeLimitResetTerminalOptions = { ...options.terminal, programs };

  const ensureCwd = fs
    .makeDirectory(options.terminal.cwd, { recursive: true })
    .pipe(Effect.mapError((cause) => new ClaudeLimitResetError({ reason: "readFailed", cause })));

  /** The grants and the account they belong to; a login changed meanwhile fails the read. */
  const readGrants = Effect.fn("ClaudeLimitResets.readGrants")(function* (texts: GrantedTexts) {
    const before = yield* accountKey;
    yield* ensureCwd;
    const grants = yield* readClaudeLimitResets(terminalOptions, texts);
    if ((yield* accountKey) !== before) {
      return yield* new ClaudeLimitResetError({ reason: "readFailed" });
    }
    return { grants, ...(before === undefined ? {} : { accountKey: before }) };
  });

  const read = Effect.gen(function* () {
    const count = yield* redemptions;
    const result = yield* programs.pipe(
      Effect.flatMap(({ granted }) =>
        granted === undefined ? Effect.succeedNone : Effect.asSome(readGrants(granted)),
      ),
      Effect.result,
    );
    const at = yield* Clock.currentTimeMillis;
    if (result._tag === "Failure") {
      const reason = FAILURE_REASONS[result.failure.reason];
      yield* Effect.logWarning("Claude limit resets could not be read.", { reason });
      yield* Ref.update(state, ({ reading: _reading, failure, ...current }) => ({
        ...current,
        failure: { at, reason, attempts: (failure?.attempts ?? 0) + 1, redemptions: count },
      }));
    } else if (Option.isSome(result.success)) {
      const reading = { at, redemptions: count, ...result.success.value };
      yield* Ref.update(state, ({ failure: _failure, ...current }) => ({ ...current, reading }));
    }
  });

  // A read due while this instance's read waits for the login's lock or runs is that same read.
  const readQueued = yield* Semaphore.make(1);
  const startRead = readQueued
    .withPermitsIfAvailable(1)(coordinator.runLocked(options.loginKey, read))
    .pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: () => options.onRead })),
      Effect.provideContext(context),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  /** The reset fields to publish with `usageLimits`; starts a read when one is due. */
  const current = Effect.fn("ClaudeLimitResets.current")(function* (
    usageLimits: ServerProviderUsageLimits,
  ) {
    const enabled = yield* Effect.result(programs);
    if (enabled._tag === "Failure") {
      return { resetCreditsError: "readFailed" } satisfies ClaudeLimitResetFields;
    }
    const now = yield* Clock.currentTimeMillis;
    const before = yield* Ref.getAndUpdate(state, (current) => withUsage(current, usageLimits));
    const usage: ClaudeLimitResetUsage = {
      now,
      limited: withUsage(before, usageLimits).limited,
      redemptions: yield* redemptions,
      ...(usageLimits.accountKey === undefined ? {} : { accountKey: usageLimits.accountKey }),
    };
    const weeklySessionAvailableAt =
      before.weeklySessionAvailableAt !== undefined &&
      Date.parse(before.weeklySessionAvailableAt) > now
        ? before.weeklySessionAvailableAt
        : undefined;
    const resetPrograms: ServerProviderResetPrograms = {
      granted: enabled.success.granted !== undefined,
      weeklySession: enabled.success.weeklySession !== undefined,
      ...(weeklySessionAvailableAt === undefined ? {} : { weeklySessionAvailableAt }),
    };
    // Without banked grants there is nothing to read; the weekly 5-hour reset shows only at a limit.
    if (enabled.success.granted === undefined) return { resetPrograms };
    if (isLimitResetReadDue(before, usage)) yield* startRead;
    if (before.failure !== undefined) {
      return { resetCreditsError: before.failure.reason, resetPrograms };
    }
    return {
      ...(before.reading === undefined || !describes(before.reading, usage)
        ? {}
        : { resetCredits: toResetCredits(before.reading.grants) }),
      resetPrograms,
    };
  });

  /** The grants to choose from: the last reading while it still describes this login's account. */
  const knownGrants = Effect.fn("ClaudeLimitResets.knownGrants")(function* (texts: GrantedTexts) {
    const { reading } = yield* Ref.get(state);
    const key = yield* accountKey;
    const now = {
      redemptions: yield* redemptions,
      ...(key === undefined ? {} : { accountKey: key }),
    };
    if (reading !== undefined && describes(reading, now)) return reading.grants;
    return (yield* readGrants(texts)).grants;
  });

  const claimOnce = Effect.fn("ClaudeLimitResets.claimOnce")(function* (
    forAccount: string | undefined,
    kind: ServerProviderResetKind | undefined,
  ) {
    const holdsAccount = Effect.flatMap(accountKey, (key) =>
      key === forAccount
        ? Effect.void
        : Effect.fail(new ClaudeLimitResetError({ reason: "accountChanged" })),
    );
    yield* holdsAccount;
    const claimOptions = { ...terminalOptions, holdsAccount };
    const enabled = yield* programs;
    if (enabled.granted !== undefined) {
      const chosen = kind ?? firstToExpire(yield* knownGrants(enabled.granted));
      if (chosen === undefined) {
        return { _tag: "outcome", outcome: "noCredit" } satisfies ClaudeClaimAnswer;
      }
      yield* ensureCwd;
      return yield* claimClaudeGrantedReset(claimOptions, enabled.granted, chosen);
    }
    // A named kind is a granted reset, so the redeemer's 5-hour claim never spends the weekly one.
    if (enabled.weeklySession !== undefined && kind === undefined) {
      yield* ensureCwd;
      return yield* claimClaudeWeeklySessionReset(claimOptions, enabled.weeklySession);
    }
    return { _tag: "outcome", outcome: "noCredit" } satisfies ClaudeClaimAnswer;
  });

  /**
   * Uses one reset of `forAccount`, the account key of the usage it was chosen from, and none once
   * the login holds another account: a granted one of `kind`, or unasked the usable grant that
   * expires first, or else the weekly 5-hour one. Fails with why when Claude gave no outcome; every claim, however it ends,
   * counts as a redemption, so the grants are read again before they are shown or chosen from.
   */
  const claim = Effect.fn("ClaudeLimitResets.claim")(function* (
    forAccount: string | undefined,
    kind?: ServerProviderResetKind,
  ) {
    return yield* coordinator.redeem(options.loginKey, () =>
      claimOnce(forAccount, kind).pipe(
        Effect.flatMap((answer) => {
          if (answer._tag !== "outcome") {
            return Effect.fail(new ClaudeLimitResetError({ reason: answer._tag }));
          }
          const availableAt = answer.weeklySessionAvailableAt;
          return Ref.update(state, (current) =>
            availableAt === undefined
              ? current
              : { ...current, weeklySessionAvailableAt: availableAt },
          ).pipe(Effect.as(answer.outcome));
        }),
        Effect.provideContext(context),
      ),
    );
  });

  return { current, claim };
});

export type ClaudeLimitResets = Effect.Success<ReturnType<typeof makeClaudeLimitResets>>;
