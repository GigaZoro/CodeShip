import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BROWSER_PROFILE_MAX_COUNT, BrowserProfile, BrowserProfileId } from "./browserProfile.ts";
import {
  BrowserRecordingFrameRate,
  PreviewAppearancePreference,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./settingsPrimitives.ts";

export const PREVIEW_URL_MAX_LENGTH = 2_048;
export const CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS = 32;

const Url = TrimmedNonEmptyString.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH));

export const ConfiguredLocalServerUrls = Schema.Array(Url).check(
  Schema.isMaxLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS),
);
const Title = Schema.String.check(Schema.isMaxLength(512));

export const PreviewTabId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewTabId = typeof PreviewTabId.Type;

/** Fill mode can measure below selectable minimum sizes; validate measurements separately. */
export const PreviewRenderedViewportSize = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewRenderedViewportSize = typeof PreviewRenderedViewportSize.Type;

const PreviewFileDownload = Schema.Struct({ id: Schema.String, fileName: Schema.String });

export const PreviewNavStatus = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("Success", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("LoadFailed", {
    url: Url,
    title: Title,
    code: Schema.Int,
    description: Schema.String,
    download: Schema.optional(PreviewFileDownload),
  }),
]);
export type PreviewNavStatus = typeof PreviewNavStatus.Type;

export const PreviewRuntime = Schema.Literals(["desktop", "server"]);
export type PreviewRuntime = typeof PreviewRuntime.Type;

/** JSON reason for preview stream close code 4503; must fit the 123-byte close-reason limit. */
export const PreviewStreamHostSetup = Schema.Struct({
  need: Schema.Literals(["sandbox", "libraries"]),
  command: Schema.String,
});
export type PreviewStreamHostSetup = typeof PreviewStreamHostSetup.Type;
export const PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE = 4503;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  viewport: Schema.optional(PreviewViewportSetting),
  colorScheme: Schema.optional(PreviewAppearancePreference),
  zoomFactor: Schema.optional(PreviewZoomFactor),
  /** Fixed at open; Electron cannot change a webview partition after attach without losing page state. */
  profileId: Schema.optional(BrowserProfileId),
  runtime: Schema.optional(PreviewRuntime),
  /** The server runs this tab in headless Chromium, so the desktop streams it like other clients. */
  headless: Schema.optional(Schema.Boolean),
  automationOwner: Schema.optional(Schema.String),
  reveal: Schema.optional(Schema.Boolean),
  revealRequest: Schema.optional(Schema.Struct({ id: Schema.String, force: Schema.Boolean })),
  updatedAt: Schema.String,
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  url: Schema.optional(Url),
  viewport: Schema.optional(PreviewViewportSetting),
  profileId: Schema.optional(BrowserProfileId),
  runtime: Schema.optional(PreviewRuntime),
  reveal: Schema.optional(Schema.Boolean),
  openerTabId: Schema.optional(PreviewTabId),
});
export type PreviewOpenInput = typeof PreviewOpenInput.Type;

export const PreviewReportStatusInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
});
export type PreviewReportStatusInput = typeof PreviewReportStatusInput.Type;

export const PreviewResizeInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  viewport: PreviewViewportSetting,
});
export type PreviewResizeInput = typeof PreviewResizeInput.Type;

/** Requires no tab control, unlike page input. */
export const PreviewAdjustInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  colorScheme: Schema.optional(PreviewAppearancePreference),
  zoomFactor: Schema.optional(PreviewZoomFactor),
  hardReload: Schema.optional(Schema.Boolean),
  clear: Schema.optional(Schema.Literals(["cookies", "cache"])),
});
export type PreviewAdjustInput = typeof PreviewAdjustInput.Type;

export const PreviewCloseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
});
export type PreviewCloseInput = typeof PreviewCloseInput.Type;

export const PreviewReportProfilesInput = Schema.Struct({
  profiles: Schema.Array(BrowserProfile).check(Schema.isMaxLength(BROWSER_PROFILE_MAX_COUNT)),
  defaultProfileId: BrowserProfileId,
  /** Optional so older clients keep reporting; omitting it keeps the last reported rate. */
  recordingFrameRate: Schema.optional(BrowserRecordingFrameRate),
});
export type PreviewReportProfilesInput = typeof PreviewReportProfilesInput.Type;

export const PreviewClearProfileInput = Schema.Struct({
  profileId: BrowserProfileId,
});
export type PreviewClearProfileInput = typeof PreviewClearProfileInput.Type;

export const PreviewListInput = Schema.Struct({
  threadId: ThreadId,
});
export type PreviewListInput = typeof PreviewListInput.Type;

export const PreviewListResult = Schema.Struct({
  sessions: Schema.Array(PreviewSessionSnapshot),
  /** Identifies the current server process so revision resets are safe. */
  serverEpoch: TrimmedNonEmptyString,
  revision: NonNegativeInt,
});
export type PreviewListResult = typeof PreviewListResult.Type;

const PreviewEventBaseSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  createdAt: Schema.String,
  serverEpoch: TrimmedNonEmptyString,
  /** Monotonic server state revision shared with PreviewListResult. */
  revision: PositiveInt,
});

const PreviewOpenedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("opened"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewNavigatedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("navigated"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewResizedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("resized"),
  snapshot: PreviewSessionSnapshot,
  request: Schema.optional(
    Schema.Struct({
      hardReload: Schema.optional(Schema.Boolean),
      clear: Schema.optional(Schema.Literals(["cookies", "cache"])),
    }),
  ),
});

const PreviewFailedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("failed"),
  url: Url,
  title: Title,
  code: Schema.Int,
  description: Schema.String,
  download: Schema.optional(PreviewFileDownload),
});

const PreviewClosedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

export const PreviewEvent = Schema.Union([
  PreviewOpenedEvent,
  PreviewNavigatedEvent,
  PreviewResizedEvent,
  PreviewFailedEvent,
  PreviewClosedEvent,
]);
export type PreviewEvent = typeof PreviewEvent.Type;

const LocalServerPort = Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536));

export const DiscoveredLocalServer = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: LocalServerPort,
  url: Url,
  processName: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  terminal: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      terminalId: TrimmedNonEmptyString,
    }),
  ),
  /** Started by the thread's agent. Older servers omit it. */
  agent: Schema.optionalKey(Schema.NullOr(Schema.Struct({ threadId: ThreadId }))),
});
export type DiscoveredLocalServer = typeof DiscoveredLocalServer.Type;

export const PreviewStopLocalServerInput = Schema.Struct({
  pid: PositiveInt,
  port: LocalServerPort,
});
export type PreviewStopLocalServerInput = typeof PreviewStopLocalServerInput.Type;

export class PreviewStopLocalServerError extends Schema.TaggedError<PreviewStopLocalServerError>()(
  "PreviewStopLocalServerError",
  {
    reason: Schema.Literals(["not-found", "shared-group", "unsupported", "signal-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-found":
        return "This server is no longer running.";
      case "shared-group":
        return "This server shares a process group with T3.CodeShip, an agent, or a terminal shell, so it can't be stopped on its own.";
      case "unsupported":
        return "Stopping servers is not supported on this environment's platform.";
      case "signal-failed":
        return "The server's processes could not be signaled.";
    }
  }
}

export const DiscoveredLocalServerList = Schema.Struct({
  servers: Schema.Array(DiscoveredLocalServer),
  scannedAt: Schema.String,
  configuredUrlProbing: Schema.optional(Schema.Literal(true)),
});
export type DiscoveredLocalServerList = typeof DiscoveredLocalServerList.Type;

export class PreviewSessionLookupError extends Schema.TaggedError<PreviewSessionLookupError>()(
  "PreviewSessionLookupError",
  {
    threadId: Schema.String,
    tabId: Schema.String,
  },
) {
  override get message() {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedError<PreviewInvalidUrlError>()(
  "PreviewInvalidUrlError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol", "unexpected"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export class PreviewControlRequiredError extends Schema.TaggedError<PreviewControlRequiredError>()(
  "PreviewControlRequiredError",
  { tabId: Schema.String },
) {
  override get message() {
    return "Take control of the server browser and use its viewer controls.";
  }
}

export class PreviewClearProfileError extends Schema.TaggedError<PreviewClearProfileError>()(
  "PreviewClearProfileError",
  { profileId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "The environment could not delete this browser profile's data.";
  }
}

export const PreviewError = Schema.Union([
  PreviewSessionLookupError,
  PreviewInvalidUrlError,
  PreviewControlRequiredError,
]);
export type PreviewError = typeof PreviewError.Type;
