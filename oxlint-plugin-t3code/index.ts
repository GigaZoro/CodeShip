import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noDomTestEnvironment from "./rules/no-dom-test-environment.ts";
import noEmDashCopy from "./rules/no-em-dash-copy.ts";
import noFrameWaitsInBrowserTests from "./rules/no-frame-waits-in-browser-tests.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noHermesUnsupportedApis from "./rules/no-hermes-unsupported-apis.ts";
import noHooklessUseFunction from "./rules/no-hookless-use-function.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noLowValueComments from "./rules/no-low-value-comments.ts";
import noManualMemo from "./rules/no-manual-memo.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noMobileUniwindThemeEscapeHatches from "./rules/no-mobile-uniwind-theme-escape-hatches.ts";
import noAmbiguousDetailNavigation from "./rules/no-ambiguous-detail-navigation.ts";
import noCanonicalKeyComparison from "./rules/no-canonical-key-comparison.ts";
import noMobilePullRequestGlyphLiterals from "./rules/no-mobile-pull-request-glyph-literals.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noUnreasonedStateSync from "./rules/no-unreasoned-state-sync.ts";
import noUntranslatedText from "./rules/no-untranslated-text.ts";
import requireFormattingLocale from "./rules/require-formatting-locale.ts";
import requireRegisteredListScroll from "./rules/require-registered-list-scroll.ts";
import noOutsetStateIndicators from "./rules/no-outset-state-indicators.ts";
import noPlatformEarlyReturnInTests from "./rules/no-platform-early-return-in-tests.ts";
import noPollingLoopInTests from "./rules/no-polling-loop-in-tests.ts";
import noRawMcpRegistration from "./rules/no-raw-mcp-registration.ts";
import noRawProcessProbe from "./rules/no-raw-process-probe.ts";
import noRawTaskkill from "./rules/no-raw-taskkill.ts";
import noRetiredEventTable from "./rules/no-retired-event-table.ts";
import noRemoteGitThroughExecute from "./rules/no-remote-git-through-execute.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noRealTimeWaitInTests from "./rules/no-real-time-wait-in-tests.ts";
import noDuplicateTestTitle from "./rules/no-duplicate-test-title.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noTestTimeoutOrUnreasonedSkip from "./rules/no-test-timeout-or-unreasoned-skip.ts";
import noRpcPermissionBypass from "./rules/no-rpc-permission-bypass.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
import noWallClockInTests from "./rules/no-wall-clock-in-tests.ts";
import noWildcardListenInTests from "./rules/no-wildcard-listen-in-tests.ts";
import noWow64BinaryPath from "./rules/no-wow64-binary-path.ts";
import noCheckoutTempDirInTests from "./rules/no-checkout-temp-dir-in-tests.ts";
import preferCatchTags from "./rules/prefer-catch-tags.ts";
import preferEffectFn from "./rules/prefer-effect-fn.ts";
import requireCenteredScrollGutter from "./rules/require-centered-scroll-gutter.ts";
import requireDisposableRender from "./rules/require-disposable-render.ts";
import requireJsonWrappedSubquery from "./rules/require-json-wrapped-subquery.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";
import requireToastSource from "./rules/require-toast-source.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-dom-test-environment": noDomTestEnvironment,
    "no-em-dash-copy": noEmDashCopy,
    "no-frame-waits-in-browser-tests": noFrameWaitsInBrowserTests,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-hermes-unsupported-apis": noHermesUnsupportedApis,
    "no-hookless-use-function": noHooklessUseFunction,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-low-value-comments": noLowValueComments,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-manual-memo": noManualMemo,
    "no-mobile-uniwind-theme-escape-hatches": noMobileUniwindThemeEscapeHatches,
    "no-ambiguous-detail-navigation": noAmbiguousDetailNavigation,
    "no-canonical-key-comparison": noCanonicalKeyComparison,
    "no-mobile-pull-request-glyph-literals": noMobilePullRequestGlyphLiterals,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-unreasoned-state-sync": noUnreasonedStateSync,
    "no-untranslated-text": noUntranslatedText,
    "require-formatting-locale": requireFormattingLocale,
    "require-registered-list-scroll": requireRegisteredListScroll,
    "no-outset-state-indicators": noOutsetStateIndicators,
    "no-platform-early-return-in-tests": noPlatformEarlyReturnInTests,
    "no-polling-loop-in-tests": noPollingLoopInTests,
    "no-raw-mcp-registration": noRawMcpRegistration,
    "no-raw-process-probe": noRawProcessProbe,
    "no-raw-taskkill": noRawTaskkill,
    "no-retired-event-table": noRetiredEventTable,
    "no-remote-git-through-execute": noRemoteGitThroughExecute,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-real-time-wait-in-tests": noRealTimeWaitInTests,
    "no-duplicate-test-title": noDuplicateTestTitle,
    "no-test-in-loop": noTestInLoop,
    "no-test-timeout-or-unreasoned-skip": noTestTimeoutOrUnreasonedSkip,
    "no-rpc-permission-bypass": noRpcPermissionBypass,
    "no-unscoped-has": noUnscopedHas,
    "no-wall-clock-in-tests": noWallClockInTests,
    "no-wildcard-listen-in-tests": noWildcardListenInTests,
    "no-wow64-binary-path": noWow64BinaryPath,
    "no-checkout-temp-dir-in-tests": noCheckoutTempDirInTests,
    "prefer-catch-tags": preferCatchTags,
    "prefer-effect-fn": preferEffectFn,
    "require-centered-scroll-gutter": requireCenteredScrollGutter,
    "require-disposable-render": requireDisposableRender,
    "require-json-wrapped-subquery": requireJsonWrappedSubquery,
    "require-suppression-reason": requireSuppressionReason,
    "require-toast-source": requireToastSource,
  },
});
