/**
 * Reads the answers of Claude Code's `/limit-reset` command from its terminal text. Every pattern
 * is built from the CLI's own templates, which its `tengu_cedar_ember` and `tengu_nifty_lemur`
 * flags may replace, so a reworded answer is reported as unrecognized instead of guessed at.
 */
import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetKind,
  ServerProviderResetKindUnknownReason,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const SEPARATOR = " · ";

/** The banked-grant (`tengu_cedar_ember`) texts this reader matches, as Claude Code 2.1 renders them. */
export const GRANTED_TEXTS = {
  confirmTitle: "Use a {kind}?",
  confirmDetail: "{kindResets} left · use by {deadline}",
  confirmYes: "Yes, use my {kind}",
  confirmNo: "No, keep it",
  chooseTitle: "Which reset do you want to use?",
  keptChoiceLine: "Resets kept · run /limit-reset when you want one · first expires {deadline}",
  noKindLine: "No {kind} to use",
  spentLine: "Reset used · {resets} left",
  successLine: "{done} · your weekly reset day stays {week} · {kindResets} left",
  keptLine: "{Kind} kept · run /limit-reset at a limit to use it · use by {deadline}",
  keptAnytimeLine: "{Kind} kept · run /limit-reset whenever you want to use it · use by {deadline}",
  unavailableLine: "Couldn't reset your limits · nothing was used · try again in a moment",
  unconfirmedLine:
    "Couldn't confirm the reset went through · if you're still at the limit in a moment, try again",
  unconfirmedAnytimeLine:
    "Couldn't confirm the reset went through · check /usage in a moment · if your limits weren't refilled, run /limit-reset again",
  stillUnconfirmedLine:
    "Still couldn't confirm your reset · nothing more was used · if your limits aren't refilled in a few minutes, contact support",
} as const;
export type GrantedTexts = { readonly [Key in keyof typeof GRANTED_TEXTS]: string };

/** The weekly 5-hour reset (`tengu_nifty_lemur`) texts this reader matches. */
export const WEEKLY_SESSION_TEXTS = {
  spentLine: "Weekly reset used · available again {date}",
  successLine: "5-hour limit reset · next reset available {date} · your weekly limit still applies",
  unavailableLine: "Couldn't reset your 5-hour limit right now · try again in a moment",
} as const;
export type WeeklySessionTexts = { readonly [Key in keyof typeof WEEKLY_SESSION_TEXTS]: string };

/** The descriptions the typeahead shows beside `/limit-reset` for each program. */
export const GRANTED_DESCRIPTION = "Use an available limit reset and keep working";
export const WEEKLY_SESSION_DESCRIPTION =
  "Reset your 5-hour limit now and keep working; once a week, still counts toward your weekly limit";

/** Replaces each default with the flag's own non-empty text of the same key, as Claude does. */
export function withTextOverrides<Texts extends Record<string, string>>(
  defaults: Texts,
  flag: unknown,
): Texts {
  if (typeof flag !== "object" || flag === null || Array.isArray(flag)) return defaults;
  const overrides = flag as Record<string, unknown>;
  const texts: Record<string, string> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = overrides[key];
    if (typeof value === "string" && value.trim() !== "") texts[key] = value;
  }
  return texts as Texts;
}

const KIND_LABELS: Record<ServerProviderResetKind, string> = {
  five_hour: "5-hour reset",
  weekly: "weekly reset",
  full: "full reset",
  fable: "Fable reset",
};
const KIND_DONE: Record<ServerProviderResetKind, string> = {
  five_hour: "5-hour limit reset",
  weekly: "Weekly limits reset",
  full: "Limits reset",
  fable: "Fable reset used · what Fable used is back in your weekly limit",
};
/** The argument `/limit-reset` takes for each kind. */
export const KIND_ARGUMENTS: Record<ServerProviderResetKind, string> = {
  five_hour: "5-hour",
  weekly: "weekly",
  full: "full",
  fable: "fable",
};
export const RESET_KINDS = Object.keys(KIND_LABELS) as ReadonlyArray<ServerProviderResetKind>;

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function kindValues(kind: ServerProviderResetKind): Record<string, string> {
  return {
    kind: KIND_LABELS[kind],
    Kind: capitalized(KIND_LABELS[kind]),
    done: KIND_DONE[kind],
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches one filled template: known placeholders are literal, the others are captured. Claude
 * drops a ` · ` segment whose value is missing, so a later segment that captures may be absent.
 */
function matchTemplate(
  template: string,
  text: string,
  known: Record<string, string> = {},
): Record<string, string> | undefined {
  const seen = new Set<string>();
  const segments = template.split(SEPARATOR).map((segment) => {
    let captures = false;
    const source = segment
      .split(/(\{[A-Za-z]+\})/)
      .map((part) => {
        const name = /^\{([A-Za-z]+)\}$/.exec(part)?.[1];
        if (name === undefined) return escapeRegExp(part);
        const value = known[name];
        if (value !== undefined) return escapeRegExp(value);
        captures = true;
        if (seen.has(name)) return `\\k<${name}>`;
        seen.add(name);
        return `(?<${name}>.+?)`;
      })
      .join("");
    return { source, captures };
  });
  const pattern = segments
    .map(({ source, captures }, index) => {
      if (index === 0) return source;
      const joined = `${escapeRegExp(SEPARATOR)}${source}`;
      return captures ? `(?:${joined})?` : joined;
    })
    .join("");
  const match = new RegExp(`^${pattern}$`).exec(text);
  if (match === null) return undefined;
  return { ...match.groups };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Reads Claude's short dates (`Dec 1`, `Dec 1, 2027`, `Dec 1, 3pm`, `Dec 1, 3:30pm`), which its
 * terminal renders in UTC because the reader starts it with `TZ=UTC`. A date without a time is the
 * start of that day, so an expiry is never read as later than it is.
 */
export function parseClaudeDate(text: string, now: DateTime.Utc): string | undefined {
  const match =
    /^(?<month>[A-Z][a-z]{2}) (?<day>\d{1,2})(?:, (?<year>\d{4}))?(?:, (?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?<half>am|pm))?$/.exec(
      text.trim(),
    );
  const groups = match?.groups;
  if (!groups) return undefined;
  const month = MONTHS.indexOf(groups.month!);
  const day = Number(groups.day);
  const year = groups.year === undefined ? DateTime.getPartUtc(now, "year") : Number(groups.year);
  const hour12 = groups.hour === undefined ? 0 : Number(groups.hour);
  const minute = groups.minute === undefined ? 0 : Number(groups.minute);
  if (month < 0 || day < 1 || day > 31 || hour12 > 12 || minute > 59) return undefined;
  const hour = groups.half === undefined ? 0 : (hour12 % 12) + (groups.half === "pm" ? 12 : 0);
  const at = DateTime.makeUnsafe({ year, month: month + 1, day, hour, minute });
  if (DateTime.getPartUtc(at, "day") !== day) return undefined;
  return DateTime.formatIso(at);
}

/** `no resets`, `1 reset`, `3 weekly resets`, `no five-hour resets` as a count. */
function parseCount(text: string | undefined): number | undefined {
  const match = /^(no|\d+) [^·]*?resets?$/.exec(text?.trim() ?? "");
  if (match === null) return undefined;
  return match[1] === "no" ? 0 : Number(match[1]);
}

/**
 * One grant as `/limit-reset` describes it; Claude never shows a grant's id. It names the kind of
 * a grant it holds back only beside a usable one, and then without a count.
 */
export type ClaudeLimitResetGrant =
  | {
      readonly kind: ServerProviderResetKind;
      readonly kindUnknownReason?: never;
      readonly resetsLeft: number;
      readonly expiresAt?: string;
      readonly usableNow: true;
      readonly requiresLimit: boolean;
    }
  | {
      readonly kind: ServerProviderResetKind;
      readonly kindUnknownReason?: never;
      readonly usableNow: false;
      readonly requiresLimit?: true;
    }
  | {
      readonly kind?: never;
      readonly kindUnknownReason: ServerProviderResetKindUnknownReason;
      readonly resetsLeft: number;
      readonly expiresAt?: string;
      readonly usableNow: false;
      readonly requiresLimit?: true;
      readonly paused?: true;
    };
export type ClaudeUsableGrant = Extract<ClaudeLimitResetGrant, { readonly usableNow: true }>;

/** The answer to a bare `/limit-reset` when Claude offers no grant to use now. */
export type ClaudeNoOfferAnswer =
  | { readonly _tag: "grants"; readonly grants: ReadonlyArray<ClaudeLimitResetGrant> }
  | { readonly _tag: "transient" }
  /** Resets wait while the account runs at lower priority; Claude says so before reading any. */
  | { readonly _tag: "lowPriority" };

const NOT_AT_LIMIT = "No reset to use · you're not at a usage limit right now";
const LOW_PRIORITY =
  "Resets can't be used while you continue at lower priority · run /limit-reset after that ends";
const TRANSIENT_ANSWERS = [
  "Couldn't check for a reset right now · try again in a moment",
  "Your limits are already being reset · one moment",
];

/** Reads Claude's answer when it has no grant to offer now; undefined when the text is unknown. */
export function parseNoOfferAnswer(
  text: string,
  texts: GrantedTexts,
  now: DateTime.Utc,
): ClaudeNoOfferAnswer | undefined {
  if (text === NOT_AT_LIMIT) return { _tag: "grants", grants: [] };
  if (TRANSIENT_ANSWERS.includes(text) || text === texts.unconfirmedAnytimeLine) {
    return { _tag: "transient" };
  }
  if (text === LOW_PRIORITY) return { _tag: "lowPriority" };
  const spent = matchTemplate(texts.spentLine, text);
  if (spent !== undefined && parseCount(spent.resets) === 0) return { _tag: "grants", grants: [] };
  const held =
    /^(?<reason>.+?) · (?<resets>no resets|1 reset|\d+ resets) left(?: · use by (?<date>.+))?$/.exec(
      text,
    )?.groups;
  if (held === undefined) return undefined;
  const reason = held.reason!;
  const known =
    /^Your reset doesn't refill your .+, so it can't be used until that resets$/.test(reason) ||
    reason.startsWith("Your reset can't be used right now · ") ||
    reason ===
      "You have a reset saved for when you reach a usage limit · run /limit-reset when you do";
  if (!known) return undefined;
  const expiresAt = held.date === undefined ? undefined : parseClaudeDate(held.date, now);
  if (held.date !== undefined && expiresAt === undefined) return undefined;
  // With no grant usable now, Claude answers every `/limit-reset`, with or without a kind, with
  // this total over all grants and the first one's expiry, so no command shows their kinds.
  return {
    _tag: "grants",
    grants: [
      {
        kindUnknownReason: "totalOnly",
        resetsLeft: parseCount(held.resets)!,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        usableNow: false,
        ...(reason.startsWith("You have a reset saved") ? { requiresLimit: true } : {}),
        ...(reason.endsWith(" · it is paused") ? { paused: true } : {}),
      },
    ],
  };
}

/** The answer to `/limit-reset <kind>` when Claude opens no dialog for that kind. */
export type ClaudeKindAnswer =
  | { readonly _tag: "none" }
  | { readonly _tag: "unusable"; readonly requiresLimit: boolean };

export function parseKindAnswer(
  text: string,
  kind: ServerProviderResetKind,
  texts: GrantedTexts,
): ClaudeKindAnswer | undefined {
  const values = kindValues(kind);
  const [head] = text.split(" · you can use ");
  if (head === undefined || head === text) return undefined;
  if (matchTemplate(texts.noKindLine, head, values) !== undefined) return { _tag: "none" };
  const prefix = `Your ${values.kind} `;
  if (!head.startsWith(prefix)) return undefined;
  return {
    _tag: "unusable",
    requiresLimit: head.includes("usable once you reach a limit it refills"),
  };
}

export interface ClaudeConfirmDialog {
  readonly kind: ServerProviderResetKind;
  readonly resetsLeft: number;
  readonly expiresAt?: string;
  /** Whether the highlighted option is the one that uses the reset. */
  readonly yesSelected: boolean;
}

const optionText = (line: string) => line.replace(/^\s*(?:❯\s)?\s*/, "").trimEnd();
const isSelectedOption = (line: string) => /^\s*❯\s/.test(line);

/**
 * Finds Claude's "Use a … ?" dialog on the screen and reads the grant it offers. A dialog whose
 * count or deadline does not read is not recognized, so no count is guessed.
 */
export function parseConfirmDialog(
  lines: ReadonlyArray<string>,
  texts: GrantedTexts,
  now: DateTime.Utc,
): ClaudeConfirmDialog | undefined {
  const trimmed = lines.map((line) => line.trim());
  for (const kind of RESET_KINDS) {
    const values = kindValues(kind);
    const title = trimmed.findIndex(
      (line) => matchTemplate(texts.confirmTitle, line, values) !== undefined,
    );
    if (title === -1) continue;
    const yes = lines.findIndex(
      (line, index) =>
        index > title && matchTemplate(texts.confirmYes, optionText(line), values) !== undefined,
    );
    const no = lines.findIndex(
      (line, index) =>
        index > title && matchTemplate(texts.confirmNo, optionText(line), values) !== undefined,
    );
    if (yes === -1 || no === -1) continue;
    const detail = trimmed
      .slice(title + 1, yes)
      .map((line) => matchTemplate(texts.confirmDetail, line, values))
      .find((groups) => groups !== undefined);
    const resetsLeft = parseCount(detail?.kindResets);
    if (detail === undefined || resetsLeft === undefined) return undefined;
    const expiresAt =
      detail.deadline === undefined ? undefined : parseClaudeDate(detail.deadline, now);
    if (detail.deadline !== undefined && expiresAt === undefined) return undefined;
    return {
      kind,
      resetsLeft,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      yesSelected: isSelectedOption(lines[yes]!) && !isSelectedOption(lines[no]!),
    };
  }
  return undefined;
}

export const isChooseDialog = (lines: ReadonlyArray<string>, texts: GrantedTexts) =>
  lines.some((line) => line.trim() === texts.chooseTitle);

/** Reads the line Claude prints when a dialog is left without using the reset. */
export function parseKeptLine(
  text: string,
  texts: GrantedTexts,
  kind?: ServerProviderResetKind,
): { readonly requiresLimit: boolean } | undefined {
  if (matchTemplate(texts.keptChoiceLine, text) !== undefined) return { requiresLimit: false };
  if (kind === undefined) return undefined;
  const values = kindValues(kind);
  if (matchTemplate(texts.keptLine, text, values) !== undefined) return { requiresLimit: true };
  if (matchTemplate(texts.keptAnytimeLine, text, values) !== undefined) {
    return { requiresLimit: false };
  }
  return undefined;
}

/** What a claim ended in: one of the outcomes, or why it ended without one. */
export type ClaudeClaimAnswer =
  | {
      readonly _tag: "outcome";
      readonly outcome: ProviderConsumeResetCreditOutcome;
      readonly weeklySessionAvailableAt?: string;
    }
  /** Nothing was used and Claude asks to try again in a moment. */
  | { readonly _tag: "unavailable" }
  /** The reset may have been used; only the account's usage can tell. */
  | { readonly _tag: "unconfirmed" }
  | { readonly _tag: "signedOut" };

const GRANTED_CLAIM_ANSWERS: ReadonlyArray<readonly [string, ClaudeClaimAnswer]> = [
  [
    "Your earlier reset went through after all · checking your limits now",
    { _tag: "outcome", outcome: "reset" },
  ],
  [
    "Your reset only works at a usage limit, and you're not at one now · nothing was used",
    { _tag: "outcome", outcome: "nothingToReset" },
  ],
  ["This limit may have lifted already · ", { _tag: "outcome", outcome: "nothingToReset" }],
  [
    "That reset was already used · nothing changed just now",
    { _tag: "outcome", outcome: "alreadyRedeemed" },
  ],
  [
    "This reset isn't available any more · nothing was used",
    { _tag: "outcome", outcome: "noCredit" },
  ],
  [
    "A different reset is on offer now · nothing was used",
    { _tag: "outcome", outcome: "noCredit" },
  ],
  [
    "This reset isn't available any more · your earlier try may have gone through",
    { _tag: "unconfirmed" },
  ],
  ["Your earlier reset may still be going through · ", { _tag: "unconfirmed" }],
  [
    "Another reset was just started on your account · this one wasn't used",
    { _tag: "unavailable" },
  ],
  ["Couldn't reset your limits with this login · ", { _tag: "signedOut" }],
];

/** Reads Claude's answer after a granted reset was confirmed, or after a claim met no dialog. */
export function parseGrantedClaimAnswer(
  text: string,
  kind: ServerProviderResetKind,
  texts: GrantedTexts,
  now: DateTime.Utc,
): ClaudeClaimAnswer | undefined {
  const values = kindValues(kind);
  if (matchTemplate(texts.successLine, text, values) !== undefined) {
    return { _tag: "outcome", outcome: "reset" };
  }
  if (text === texts.unavailableLine) return { _tag: "unavailable" };
  if (
    text === texts.unconfirmedLine ||
    text === texts.unconfirmedAnytimeLine ||
    text === texts.stillUnconfirmedLine
  ) {
    return { _tag: "unconfirmed" };
  }
  if (text === `Your ${values.kind} is no longer on offer · nothing was used`) {
    return { _tag: "outcome", outcome: "noCredit" };
  }
  const fixed = GRANTED_CLAIM_ANSWERS.find(([prefix]) => text.startsWith(prefix));
  if (fixed !== undefined) return fixed[1];
  if (parseKindAnswer(text, kind, texts) !== undefined) {
    return { _tag: "outcome", outcome: "noCredit" };
  }
  const noOffer = parseNoOfferAnswer(text, texts, now);
  if (noOffer?._tag === "transient") return { _tag: "unavailable" };
  if (noOffer !== undefined) {
    return {
      _tag: "outcome",
      outcome: text === NOT_AT_LIMIT ? "nothingToReset" : "noCredit",
    };
  }
  return undefined;
}

const CONTINUE_SUFFIX = " · send a message to continue";

/** Reads Claude's answer to `/limit-reset` for the weekly 5-hour reset, which it uses without asking. */
export function parseWeeklySessionClaimAnswer(
  text: string,
  texts: WeeklySessionTexts,
  now: DateTime.Utc,
): ClaudeClaimAnswer | undefined {
  const answer = text.endsWith(CONTINUE_SUFFIX) ? text.slice(0, -CONTINUE_SUFFIX.length) : text;
  const success = matchTemplate(texts.successLine, answer);
  if (success !== undefined) {
    // Claude drops the date when the limit had already lifted ("not_limited").
    if (success.date === undefined) return { _tag: "outcome", outcome: "nothingToReset" };
    const availableAt = parseClaudeDate(success.date, now);
    return {
      _tag: "outcome",
      outcome: "reset",
      ...(availableAt === undefined ? {} : { weeklySessionAvailableAt: availableAt }),
    };
  }
  const spent = matchTemplate(texts.spentLine, answer);
  if (spent !== undefined) {
    const availableAt = spent.date === undefined ? undefined : parseClaudeDate(spent.date, now);
    return {
      _tag: "outcome",
      outcome: "alreadyRedeemed",
      ...(availableAt === undefined ? {} : { weeklySessionAvailableAt: availableAt }),
    };
  }
  if (answer === texts.unavailableLine) return { _tag: "unavailable" };
  if (answer === "A 5-hour limit reset isn't available right now.") {
    return { _tag: "outcome", outcome: "noCredit" };
  }
  if (answer === "Your 5-hour limit is already being reset · one moment") {
    return { _tag: "unconfirmed" };
  }
  if (answer.startsWith("Couldn't reset your 5-hour limit with this login · ")) {
    return { _tag: "signedOut" };
  }
  return undefined;
}
