import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = "2";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

/** Wire shapes a client understands, comma-separated; a client that omits one gets the older shape. */
export const CLIENT_CAPABILITIES_QUERY_PARAM = "clientCapabilities";
/** Secret fields may hold a secret provider reference instead of a string. */
export const SETTINGS_SECRET_REFERENCES_CAPABILITY = "settingsSecretReferences";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

// Kept outside settings.ts to avoid an orchestration import cycle.
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

// Not trimmed: a path that differs from the installed one would update the wrong home.
const InstalledPath = Schema.String.check(Schema.isNonEmpty());

export const ServerInstallation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["npx", "pnpm-dlx", "bunx"]) }),
  Schema.Struct({ kind: Schema.Literal("npm-global"), prefix: TrimmedNonEmptyString }),
  // A launcher (script, or a legacy symlink) into a downloaded runtime, as the install script and `t3 update` leave.
  Schema.Struct({
    kind: Schema.Literal("t3-launcher"),
    launcher: InstalledPath,
    baseDir: InstalledPath,
  }),
]);
export type ServerInstallation = typeof ServerInstallation.Type;

/** Where the desktop app asks its bundled server whether an update may install now. */
export const DESKTOP_AUTO_INSTALL_READINESS_PATH = "/api/server/auto-install-readiness";

/** "Install updates automatically when idle" as the server sees it; `idle` means a restart cuts no chat. */
export const DesktopAutoInstallReadiness = Schema.Struct({
  enabled: Schema.Boolean,
  idle: Schema.Boolean,
});
export type DesktopAutoInstallReadiness = typeof DesktopAutoInstallReadiness.Type;

export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestChecks: Schema.optionalKey(Schema.Boolean),
  /** Side chats: hidden `lineage.sideChat` forks. Older servers ignore the fork flag. */
  sideChats: Schema.optionalKey(Schema.Boolean),
  vcsBranchStatus: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  storageCleanupRun: Schema.optionalKey(Schema.Boolean),
  databaseStorage: Schema.optionalKey(Schema.Boolean),
  otlpEndpointCheck: Schema.optionalKey(Schema.Boolean),
  /** Serves `server.checkSecretSource`; hide the secret check where it is absent. */
  secretSourceCheck: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  settledWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  /** Serves vcs.unmergedWork, which clients check before settling a worktree thread. */
  vcsUnmergedWork: Schema.optionalKey(Schema.Boolean),
  worktreesDirectory: Schema.optionalKey(Schema.Boolean),
  /** Sent by macOS servers, which honor the fastWorktreeCheckout setting. */
  fastWorktreeCheckout: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlementScope: Schema.optionalKey(Schema.Boolean),
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /** Serves `server.updateProjectScripts`; clients change actions only through it. */
  projectScriptMutations: Schema.optionalKey(Schema.Boolean),
  /** Hide the switch when absent; older servers silently drop per-project provider patches. */
  projectProviderInstanceOverrides: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Serves `orchestration.forceStopThread`; hide Force stop where it is absent. */
  threadForceStop: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  /** Hide account switching when absent; older servers drop its settings. */
  usageLimitAccountFailover: Schema.optionalKey(Schema.Boolean),
  /** Honors `redeemUsageResets` and `maxPlanResetWaitHours`; hide their controls where absent. */
  usageResetRedeemer: Schema.optionalKey(Schema.Boolean),
  /** Honors `autoModeProvider`, `autoModeModels` and `ModelSelection.autoAccount`; hide Auto where absent. */
  autoMode: Schema.optionalKey(Schema.Boolean),
  /** Resolves fresh `ModelSelection.quotaAwareAuto` picks on the destination. */
  quotaAwareAuto: Schema.optionalKey(Schema.Boolean),
  /** Stores `newThreadsUseLastModel`; hide its switch where absent. */
  lastPickedModel: Schema.optionalKey(Schema.Boolean),
  /** Serves provider.skills.export and provider.skills.install; hide Copy to machine where absent. */
  providerSkillCopy: Schema.optionalKey(Schema.Boolean),
  /** Honors `scheduledTaskModelSelection` and a task's `followsDefaultModel`; hide both where absent. */
  scheduledTaskDefaultModel: Schema.optionalKey(Schema.Boolean),
  /** Serves `scheduledTasks.applyShared` and stores `shared`; clients sync shared tasks only here. */
  sharedScheduledTasks: Schema.optionalKey(Schema.Boolean),
  /** Stores `followSharedSettings` and serves `t3_shared_settings` to linked machines; hide that setting where absent. */
  sharedSettings: Schema.optionalKey(Schema.Boolean),
  /**
   * Serves `server.shareSettings` and takes a server's stamped share on `server.updateSettings`.
   * Where absent, a client stamps a change for all machines itself and sends the values in the patch.
   */
  shareSettings: Schema.optionalKey(Schema.Boolean),
  /** Stores `deviceSettingsProfile`; devices publish and take their profile only where it is present. */
  deviceSettingsProfile: Schema.optionalKey(Schema.Boolean),
  /** Serves `scheduledTasks.listRuns` and honors a task's `catchUpMissedRun`; hide both where absent. */
  scheduledTaskRunHistory: Schema.optionalKey(Schema.Boolean),
  /** Stores and runs a task's `runCondition`; hide its fields where absent, since older servers drop it. */
  scheduledTaskRunConditions: Schema.optionalKey(Schema.Boolean),
  /** Reads a task's `promptFile` at each run; hide that choice where absent, since older servers drop it. */
  scheduledTaskPromptFiles: Schema.optionalKey(Schema.Boolean),
  /** Stores a task's description. */
  scheduledTaskDescriptions: Schema.optionalKey(Schema.Boolean),
  /** Stores a task's `group`, serves `scheduledTasks.setGroupPaused` and `scheduledTasks.stats`; hide groups where absent. */
  scheduledTaskGroups: Schema.optionalKey(Schema.Boolean),
  /** Supports changing a task's folder without resaving the whole task. */
  scheduledTaskSetGroup: Schema.optionalKey(Schema.Boolean),
  /**
   * Stores a thread's `folder` (`thread.folder.set`), files a scheduled task's
   * chats in its group's folder, and serves `threadFolders.rename`; hide folder actions where absent.
   */
  threadFolders: Schema.optionalKey(Schema.Boolean),
  /** Accepts the thread.message.star command. */
  threadMessageStars: Schema.optionalKey(Schema.Boolean),
  /** Stores a task's `delegateProviders` and skips its runs while one is out of usage; hide that choice where absent. */
  scheduledTaskDelegateProviders: Schema.optionalKey(Schema.Boolean),
  /** Stores a task's `maxLiveRuns` and skips its runs while that many still work; hide that choice where absent. */
  scheduledTaskMaxLiveRuns: Schema.optionalKey(Schema.Boolean),
  /** Serves `scheduledTasks.subscribeLinked`: the last task list of each machine it links to. */
  linkedScheduledTasks: Schema.optionalKey(Schema.Boolean),
  /** Honors `delegatedTaskModelSelections`; hide that setting where it is absent. */
  delegatedTaskModels: Schema.optionalKey(Schema.Boolean),
  /** Runs Final review and honors the thread `finalReview` flag; hide its controls where absent. */
  finalReview: Schema.optionalKey(Schema.Boolean),
  /** Honors `workspaceSnapshotsOnDemand`; older servers send every snapshot and drop them in the stream. */
  providerWorkspaceSnapshotsOnDemand: Schema.optionalKey(Schema.Boolean),
  /** Honors `modelCatalogOnly`; older servers drop the field and probe every provider. */
  modelCatalogRefresh: Schema.optionalKey(Schema.Boolean),
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  usageModelAliases: Schema.optionalKey(Schema.Boolean),
  threadPinning: Schema.optionalKey(Schema.Boolean),
  threadNotificationLevel: Schema.optionalKey(Schema.Boolean),
  threadColor: Schema.optionalKey(Schema.Boolean),
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  /** Accepts `thread.later.set` ("Decide later" in Needs you). */
  threadLater: Schema.optionalKey(Schema.Boolean),
  /** Serves `manualSteps.list`, the Waiting steps of ThreadPage's Machine inbox. */
  manualSteps: Schema.optionalKey(Schema.Boolean),
  /** Serves `manualSteps.detected`, the sign-ins this machine noticed on its own. */
  detectedManualSteps: Schema.optionalKey(Schema.Boolean),
  /** Serves `provider.usageHolds`, the accounts CodeShip skips after a usage refusal. */
  usageHolds: Schema.optionalKey(Schema.Boolean),
  /** Serves `provider.creditGrants`, what is left of the prepaid credits each account may spend. */
  creditGrants: Schema.optionalKey(Schema.Boolean),
  /** Serves `manualSteps.review` and `manualSteps.reviewAgain`, AI reviews of manual steps. */
  manualStepReviews: Schema.optionalKey(Schema.Boolean),
  /** Serves `manualSteps.startChat`, a chat that carries out the user's decision on a step. */
  manualStepChats: Schema.optionalKey(Schema.Boolean),
  threadProjectFromScratch: Schema.optionalKey(Schema.Boolean),
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  threadVisitedTracking: Schema.optionalKey(Schema.Boolean),
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  serverResolvedCommandContext: Schema.optionalKey(Schema.Boolean),
  threadStop: Schema.optionalKey(Schema.Boolean),
  /** Absent on older servers and on Windows hosts, which cannot stop a discovered server. */
  localServerStop: Schema.optionalKey(Schema.Boolean),
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  threadPullRequestWatch: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Server answers server.getNpmRelease using its configured npm registry. */
  npmReleaseLookup: Schema.optionalKey(Schema.Boolean),
  /** Manual commands must update this install, not the host's default global prefix. */
  serverInstallation: ForwardCompatibleOptional(ServerInstallation),
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  serverUpdateStaging: Schema.optionalKey(Schema.Boolean),
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /** Serves `server.watchRestartHold`; updates wait on it only where advertised. */
  restartHold: Schema.optionalKey(Schema.Boolean),
  /** Only explicit false skips Live Activity seeding; older servers may still publish. */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  /** Server keeps `pinned` and `archived` from project.update. Older servers drop them. */
  projectOrganization: Schema.optionalKey(Schema.Boolean),
  /** Server keeps `orderKey` from project.update, so every device shares the manual project order. */
  projectOrder: Schema.optionalKey(Schema.Boolean),
  /** Server answers projects.listIgnoredFiles. */
  ignoredFileListing: Schema.optionalKey(Schema.Boolean),
  /** projects.listIgnoredFiles honors `query`. Older servers ignore it. */
  ignoredFileSearch: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  /** The desktop app switches update tracks when a server update request names one. */
  desktopAppChannelSwitch: Schema.optionalKey(Schema.Boolean),
  /** Subscribe to command output only when advertised; older servers never send it. */
  commandOutputStreaming: Schema.optionalKey(Schema.Boolean),
  /** Hosts headless Chromium tabs streamed over /api/preview-stream for clients without a local runtime. */
  serverBrowser: Schema.optionalKey(Schema.Boolean),
  /** Server links to other environments (`PeerLink`) and its agents can work
      in them. Absent on servers from before linking, which clients must not
      offer linking for. */
  peerLinks: Schema.optionalKey(Schema.Boolean),
  /** Server's `/mcp` narrows an OAuth client's modes from `T3-Mode-Limit`, so
      a linked environment's calls keep its agent's limits. Another environment
      links to this one only when it is set. */
  mcpModeLimitHeader: Schema.optionalKey(Schema.Boolean),
  /** Work a linked environment starts here stays within its link
      (`linkOrigin`). Another environment links to this one only when it is
      set, since without it that work could change the user's own threads. */
  linkFence: Schema.optionalKey(Schema.Boolean),
  /** Mints pairing codes that approve one agent sign-in at a set level (`AUTO-…`). */
  mcpApprovalCodes: Schema.optionalKey(Schema.Boolean),
  /** Agent sign-ins on its T3 Connect address are approved on the hosted app, without a code. */
  mcpHostedApproval: Schema.optionalKey(Schema.Boolean),
  /** Server answers server.prepareTriage. */
  triage: Schema.optionalKey(Schema.Boolean),
  /** Server accepts `{ type: "once" }` scheduled tasks; older servers reject them on save. */
  oneTimeSchedules: Schema.optionalKey(Schema.Boolean),
  /** Server honors `freshContext` on sends; older servers ignore it and keep the old context. */
  freshContext: Schema.optionalKey(Schema.Boolean),
  /** Server saves and runs scheduled task `threadMode`; older servers ignore it. */
  scheduledTaskThreadModes: Schema.optionalKey(Schema.Boolean),
  /** Server can transcribe 16 kHz mono PCM audio on the environment machine. */
  voiceTranscription: Schema.optionalKey(Schema.Boolean),
  cloudVoiceTranscription: Schema.optionalKey(Schema.Boolean),
  /**
   * The server config's flags of the same names. A server that names them here lets a client
   * load the shell snapshot before the socket opens, and answers its `resumeFrom`.
   */
  shellThreadFamilies: Schema.optionalKey(Schema.Boolean),
  shellOlderSettled: Schema.optionalKey(Schema.Boolean),
  /** Publishes a pull request refresh when linked-thread answers change; older servers need polling. */
  linkedThreadRefreshes: Schema.optionalKey(Schema.Boolean),
  /** Server pages `monitoring.chats` by offset; Monitoring counts only environments that set it. */
  monitoringPages: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";

/** What a starting server is doing before it serves anything. */
export const EnvironmentStartup = Schema.Struct({
  /** The database migration running now, as `<id>_<name>`. */
  migration: TrimmedNonEmptyString,
  /** Share of that migration done, 0 to 1; absent when unknown. */
  progress: Schema.optionalKey(Schema.Number),
});
export type EnvironmentStartup = typeof EnvironmentStartup.Type;

/** The body of the 503 a starting server answers its descriptor path with while it migrates. */
export const EnvironmentStartingResponse = Schema.Struct({ startup: EnvironmentStartup });
export type EnvironmentStartingResponse = typeof EnvironmentStartingResponse.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  /** GitHub `owner/repo` whose releases this server updates from; older servers omit it. */
  releaseRepository: Schema.optionalKey(TrimmedNonEmptyString),
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  /** Highest migration this server's database holds; absent on older servers. */
  databaseMigration: Schema.optionalKey(Schema.Int),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryOrigin = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  remoteUrl: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryOrigin = typeof RepositoryOrigin.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  /** Work tree root, or the git dir for a bare repository. */
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(SourceControlProviderKind),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(RepositoryOrigin),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

/** The part of an identity that says which repository a checkout is, on any machine. */
export type RepositoryKeyed = {
  readonly canonicalKey: string;
  readonly origin?: { readonly canonicalKey: string } | undefined;
};

export function repositoryGroupingKeyOf(identity: RepositoryKeyed): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

/**
 * Every key a checkout answers to, origin first. A fork with an upstream remote is keyed by the
 * upstream, and its copy on a machine without that remote by origin, so matching across machines
 * compares both.
 */
export function repositoryKeysOf(identity: RepositoryKeyed): ReadonlyArray<string> {
  return [...new Set([repositoryGroupingKeyOf(identity), identity.canonicalKey])];
}

/** `repositoryKeysOf` gives an origin and an upstream at most. */
const MAX_REPOSITORY_KEYS = 2;

/**
 * How closely `candidate` is `source`'s repository, lowest closest, or -1. A shared key ranks by
 * its place on the source's side, then on the candidate's, so a fork's checkout beats both a
 * clone of its upstream and a fork of the fork.
 */
export function repositoryMatchRank(
  source: RepositoryKeyed,
  candidate: RepositoryKeyed | null | undefined,
): number {
  if (candidate == null) return -1;
  const theirs = repositoryKeysOf(candidate);
  for (const [ours, key] of repositoryKeysOf(source).entries()) {
    const at = theirs.indexOf(key);
    if (at !== -1) return ours * MAX_REPOSITORY_KEYS + at;
  }
  return -1;
}

export function repositoryGroupingDisplayNameOf(identity: RepositoryIdentity): string | undefined {
  return identity.origin
    ? (identity.origin.displayName ?? identity.origin.canonicalKey)
    : identity.displayName;
}

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;
