import {
  type BrowserImportFailureReason,
  isRuntimeModeAbove,
  isManagedCapabilityDenied,
  type ManagedPolicySummary,
  type ProjectCloneSnapshot,
  type ProjectCloneStage,
  type ProviderRuntimeModeLimit,
  type RuntimeMode,
  type WorktreeSetupStageId,
} from "@t3tools/contracts";
import type { IdleCompactionMode } from "@t3tools/contracts/settings";
import { msg, t, type Message } from "@t3tools/shared/i18n";

const WORKTREE_SETUP_STAGE_LABELS: Record<WorktreeSetupStageId, Message> = {
  fetch: msg("Fetch base branch"),
  checkout: msg("Check out files"),
  submodules: msg("Init submodules"),
  "setup-script": msg("Run setup script"),
  agent: msg("Start agent"),
};

/** @public */
export function worktreeSetupStageLabel(id: WorktreeSetupStageId, resolve: typeof t = t): string {
  return resolve(WORKTREE_SETUP_STAGE_LABELS[id]);
}

const PROJECT_CLONE_STAGE_LABELS: Record<ProjectCloneStage, Message> = {
  connecting: msg("Connecting"),
  counting: msg("Counting objects"),
  receiving: msg("Receiving objects"),
  resolving: msg("Resolving deltas"),
  checkout: msg("Checking out files"),
};

/** @public */
export function projectCloneStageLabel(stage: ProjectCloneStage, resolve: typeof t = t): string {
  return resolve(PROJECT_CLONE_STAGE_LABELS[stage]);
}

/** @public */
export function projectCloneProgressSummary(
  snapshot: Pick<ProjectCloneSnapshot, "stage" | "percent" | "detail" | "stalled">,
  resolve: typeof t = t,
): string {
  const parts = [projectCloneStageLabel(snapshot.stage, resolve)];
  if (snapshot.percent !== null) parts.push(`${snapshot.percent}%`);
  // The detail carries git's last transfer speed, which a stall makes a lie.
  if (snapshot.stalled) parts.push(resolve(msg("Stalled")));
  else if (snapshot.detail) parts.push(snapshot.detail);
  return parts.join(" · ");
}

/** @public */
export function managedUpdatesMessage(organization: string, resolve: typeof t = t): string {
  return resolve("{organization} manages T3.CodeShip updates.", { organization });
}

/** @public */
export function managedNightlyDeniedMessage(organization: string, resolve: typeof t = t): string {
  return resolve(
    "{organization} manages T3.CodeShip updates. Only stable releases can be installed.",
    {
      organization,
    },
  );
}

/** @public */
export function managedUpdatesDenial(
  summary: ManagedPolicySummary | undefined,
  resolve: typeof t = t,
): string | undefined {
  return summary?.limits?.updates?.mode === "off"
    ? managedUpdatesMessage(summary.organization, resolve)
    : undefined;
}

/** @public */
export function managedRuntimeModeCeilingMessage(
  organization: string,
  ceiling: RuntimeMode,
  resolve: typeof t = t,
): string {
  switch (ceiling) {
    case "approval-required":
      return resolve("{organization} limits threads to Supervised.", { organization });
    case "auto-accept-edits":
      return resolve("{organization} limits threads to Auto-accept edits.", { organization });
    case "auto":
      return resolve("{organization} limits threads to Auto.", { organization });
    case "full-access":
      return resolve("{organization} limits threads to Full access.", { organization });
  }
}

/** @public */
export function managedRuntimeModeDenial(
  summary: ManagedPolicySummary | undefined,
  mode: RuntimeMode,
  resolve: typeof t = t,
): string | undefined {
  const ceiling = summary?.limits?.maxRuntimeMode;
  return summary !== undefined && ceiling !== undefined && isRuntimeModeAbove(mode, ceiling)
    ? managedRuntimeModeCeilingMessage(summary.organization, ceiling, resolve)
    : undefined;
}

/** Why a provider cannot run `mode` in the current folder, or undefined when it can. */
export function providerRuntimeModeLimitMessage(
  limits: ReadonlyArray<ProviderRuntimeModeLimit> | undefined,
  mode: RuntimeMode,
  resolve: typeof t = t,
): string | undefined {
  const limit = limits?.find((candidate) => candidate.mode === mode);
  if (limit === undefined) return undefined;
  // Only Claude's auto mode reports limits today.
  switch (limit.reason) {
    case "managed-settings":
      return resolve(msg("Your organization's Claude settings turn auto mode off."));
    case "user-settings":
      return resolve(msg("Your Claude settings turn auto mode off."));
    case "project-settings":
      return resolve(msg("This project's Claude settings turn auto mode off."));
    case "settings":
      return resolve(msg("Claude's settings turn auto mode off."));
  }
}

export type ManagedCapability =
  | "remoteClients"
  | "connect"
  | "webhookTasks"
  | "browserCookieImport"
  | "previewTunnel"
  | "worktreeLayoutCommands";

function managedCapabilityDeniedMessage(
  organization: string,
  capability: ManagedCapability,
  resolve: typeof t,
): string {
  switch (capability) {
    case "remoteClients":
      return resolve("{organization}'s policy does not allow connecting from other devices.", {
        organization,
      });
    case "connect":
      return resolve("{organization}'s policy does not allow T3 Connect.", { organization });
    case "webhookTasks":
      return resolve("{organization}'s policy does not allow webhook tasks.", { organization });
    case "browserCookieImport":
      return resolve("{organization}'s policy does not allow importing browser cookies.", {
        organization,
      });
    case "previewTunnel":
      return resolve(
        "{organization}'s policy does not allow opening this machine's local servers on other devices.",
        { organization },
      );
    case "worktreeLayoutCommands":
      return resolve("{organization}'s policy does not allow project worktree layout commands.", {
        organization,
      });
  }
}

/** @public */
export function managedCapabilityDenial(
  summary: ManagedPolicySummary | undefined,
  capability: ManagedCapability,
  resolve: typeof t = t,
): string | undefined {
  return summary !== undefined && isManagedCapabilityDenied(summary, capability)
    ? managedCapabilityDeniedMessage(summary.organization, capability, resolve)
    : undefined;
}

const IDLE_COMPACTION_MODE_LABELS: Record<IdleCompactionMode | "default", Message> = {
  default: msg("Use default"),
  onReturn: msg("When you return"),
  beforeCacheExpires: msg("Before the cache expires (beta)"),
  off: msg("Never"),
};

/** @public Labels for `IDLE_COMPACTION_MODES` values, plus the per-instance "default". */
export function idleCompactionModeLabel(
  mode: IdleCompactionMode | "default",
  resolve: typeof t = t,
): string {
  return resolve(IDLE_COMPACTION_MODE_LABELS[mode]);
}

const BROWSER_IMPORT_FAILURE_MESSAGES: Record<BrowserImportFailureReason, Message> = {
  notInstalled: msg("Not installed on this machine."),
  needsKeychainApproval: msg("Needs Keychain access to read its cookies."),
  keychainItemMissing: msg(
    "No encryption key in your Keychain. Sign in to that browser once, then retry.",
  ),
  needsFullDiskAccess: msg(
    "Give T3.CodeShip Full Disk Access in System Settings → Privacy & Security, then retry.",
  ),
  browserRunning: msg("Quit the browser first so its cookie database can be read."),
  unsupportedPlatform: msg("Importing from this browser isn't possible on this platform."),
  keychainUnavailable: msg(
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  ),
  unknownSource: msg("That browser is no longer available to import from."),
  unknownSourceProfile: msg("That browser profile no longer exists."),
  sessionUnavailable: msg("The target profile could not be opened."),
  profileNotSaved: msg(
    "The cookies were imported, but the new profile couldn't be saved. Try again.",
  ),
  profileLimitReached: msg(
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  ),
  readFailed: msg("The browser's cookie database could not be read."),
};

/** @public `BROWSER_IMPORT_FAILURE_COPY[reason]`, translated. */
export function browserImportFailureMessage(
  reason: BrowserImportFailureReason,
  resolve: typeof t = t,
): string {
  return resolve(BROWSER_IMPORT_FAILURE_MESSAGES[reason]);
}

// The server's source-control discovery hints, in the same English; commands and URLs stay as is.
const INSTALL_HINTS: ReadonlyArray<{
  readonly english: string;
  readonly message: Message;
  readonly values: Readonly<Record<string, string>>;
}> = [
  {
    english: "Install Git from https://git-scm.com/downloads or with your package manager.",
    message: msg("Install Git from {url} or with your package manager."),
    values: {
      url: "https://git-scm.com/downloads",
    },
  },
  {
    english: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
    message: msg("Install Jujutsu with {command} or from {url}."),
    values: {
      command: "`brew install jj`",
      url: "https://github.com/jj-vcs/jj",
    },
  },
  {
    english:
      "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
    message: msg(
      "Install the GitHub command-line tool ({cli}) via {url} or your package manager (for example {command}).",
    ),
    values: {
      cli: "`gh`",
      url: "https://cli.github.com/",
      command: "`brew install gh`",
    },
  },
  {
    english:
      "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).",
    message: msg(
      "Install the GitLab command-line tool ({cli}) from {url} or your package manager (for example {command}).",
    ),
    values: {
      cli: "`glab`",
      url: "https://gitlab.com/gitlab-org/cli",
      command: "`brew install glab`",
    },
  },
  {
    english:
      "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
    message: msg(
      "Install the Azure command-line tools ({cli}), then enable Azure DevOps support with {command}.",
    ),
    values: {
      cli: "`az`",
      command: "`az extension add --name azure-devops`",
    },
  },
  {
    english: "Add a Bitbucket token in Settings → Source control & issues.",
    message: msg("Add a Bitbucket token in Settings → Source control & issues."),
    values: {},
  },
  {
    english:
      "Install the Origin CLI with `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, then run `origin auth login`.",
    message: msg("Install the Origin CLI with {install}, then run {login}."),
    values: {
      install: "`curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`",
      login: "`origin auth login`",
    },
  },
  {
    english:
      "Install `fj` 0.6 or later from https://codeberg.org/forgejo-contrib/forgejo-cli and run `fj --host <server-url> auth add-token`, or install `gt` 2.0 or later from https://gitea.com/gitea/cli and run `gt auth login --host <server-url>` for each Forgejo or Gitea server.",
    message: msg(
      "Install {fj} 0.6 or later from {fjUrl} and run {fjLogin}, or install {gt} 2.0 or later from {gtUrl} and run {gtLogin} for each Forgejo or Gitea server.",
    ),
    values: {
      fj: "`fj`",
      fjUrl: "https://codeberg.org/forgejo-contrib/forgejo-cli",
      fjLogin: "`fj --host <server-url> auth add-token`",
      gt: "`gt`",
      gtUrl: "https://gitea.com/gitea/cli",
      gtLogin: "`gt auth login --host <server-url>`",
    },
  },
  {
    english:
      "Install the GitCafe CLI with `bun install -g @gitcafe/cli`, then run `cafe auth login --host https://git.cafe/api`, save a token in Settings, or set CAFE_TOKEN on the server.",
    message: msg(
      "Install the GitCafe CLI with {install}, then run {login}, save a token in Settings, or set {variable} on the server.",
    ),
    values: {
      install: "`bun install -g @gitcafe/cli`",
      login: "`cafe auth login --host https://git.cafe/api`",
      variable: "CAFE_TOKEN",
    },
  },
  {
    english:
      "Install the TanStack Source CLI with `curl -fsSL https://source.tanstack.com/install | sh`, then run `src auth login --web --hostname source.tanstack.com`, save a token in Settings, or set SRC_TOKEN on the server.",
    message: msg(
      "Install the TanStack Source CLI with {install}, then run {login}, save a token in Settings, or set {variable} on the server.",
    ),
    values: {
      install: "`curl -fsSL https://source.tanstack.com/install | sh`",
      login: "`src auth login --web --hostname source.tanstack.com`",
      variable: "SRC_TOKEN",
    },
  },
];

/** @public A source-control `installHint`, translated when it is one of the server's fixed hints. */
export function sourceControlInstallHintText(hint: string, resolve: typeof t = t): string {
  const known = INSTALL_HINTS.find((entry) => entry.english === hint);
  return known === undefined ? hint : resolve(known.message, known.values);
}
