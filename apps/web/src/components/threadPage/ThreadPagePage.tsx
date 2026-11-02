import { EnvironmentId, type DesktopPreviewTabState } from "@t3tools/contracts";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  acquireDesktopTab,
  type AcquiredDesktopTab,
  withDesktopTab,
} from "../../browser/desktopTabLifetime";
import { usePreviewWebviewConfig } from "../../browser/previewWebviewConfigState";
import { isElectron } from "../../env";
import { useClientSettingsHydrated } from "../../hooks/useSettings";
import { previewBridge } from "../preview/previewBridge";
import { isThreadPageUrl, openInSystemBrowser, THREAD_PAGE_APP_URL } from "./threadPageLinks";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const THREAD_PAGE_TAB_ID = "codeship-thread-page";
// Its own persistent session: clearing a thread browser profile must never erase
// notes that ThreadPage Free keeps in this machine's browser storage.
const THREAD_PAGE_SESSION_SCOPE = EnvironmentId.make("thread-page");

type PreviewBridge = NonNullable<typeof previewBridge>;

// Leaving the page closes its tab, so returning reopens the note the user was on.
let lastShownUrl: string | null = null;

function HeaderIconButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            aria-busy={props.busy}
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon-sm"
            variant="ghost"
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function ThreadPageShell(props: { readonly controls?: ReactNode; readonly children: ReactNode }) {
  return (
    <SidebarInset
      {...workspaceAreaProps("thread-page", 1, "ThreadPage")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <h1 className="min-w-0 truncate text-sm font-medium">ThreadPage</h1>
          <div className="ms-auto flex shrink-0 items-center gap-1">{props.controls}</div>
        </WorkspacePageHeader>
        {props.children}
      </div>
    </SidebarInset>
  );
}

/** thread.page sends X-Frame-Options: DENY, so only the desktop app can show it in place. */
function ThreadPageOpensInNewTab() {
  return (
    <ThreadPageShell>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>ThreadPage opens in its own tab</EmptyTitle>
          <EmptyDescription>
            thread.page does not let other sites embed it, so in a browser it opens in a new tab.
            The CodeShip desktop app shows it right here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            render={<a href={THREAD_PAGE_APP_URL} target="_blank" rel="noreferrer noopener" />}
          >
            <ExternalLinkIcon className="size-3.5" />
            Open ThreadPage
          </Button>
        </EmptyContent>
      </Empty>
    </ThreadPageShell>
  );
}

function ThreadPageBrowser({
  bridge,
  url,
}: {
  readonly bridge: PreviewBridge;
  readonly url: string | undefined;
}) {
  const clientSettingsHydrated = useClientSettingsHydrated();
  const [initialUrl] = useState(() => url ?? lastShownUrl ?? THREAD_PAGE_APP_URL);
  const openedUrlRef = useRef(url);
  const config = usePreviewWebviewConfig(THREAD_PAGE_SESSION_SCOPE);
  const [tab, setTab] = useState<DesktopPreviewTabState | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const leaseRef = useRef<AcquiredDesktopTab | null>(null);
  const webviewRef = useRef<HTMLElementTagNameMap["webview"] | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leases the desktop browser tab the webview registers with and closes it on leave
  useEffect(() => {
    if (!clientSettingsHydrated) return;
    const lease = acquireDesktopTab(THREAD_PAGE_TAB_ID);
    leaseRef.current = lease;
    return () => {
      if (leaseRef.current === lease) leaseRef.current = null;
      lease.release();
    };
  }, [clientSettingsHydrated]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop bridge's tab state and new-tab link events
  useEffect(() => {
    const disposeState = bridge.onStateChange((tabId, state) => {
      if (tabId !== THREAD_PAGE_TAB_ID) return;
      setTab(state);
      if (state.navStatus.kind === "Success" && isThreadPageUrl(state.navStatus.url)) {
        lastShownUrl = state.navStatus.url;
      }
    });
    // Links ThreadPage opens in a new tab stay here when they are ThreadPage's own.
    const disposeLinks = bridge.onOpenLink(({ tabId, url }) => {
      if (tabId !== THREAD_PAGE_TAB_ID) return;
      if (isThreadPageUrl(url)) void bridge.navigate(THREAD_PAGE_TAB_ID, url);
      else openInSystemBrowser(url);
    });
    return () => {
      disposeState();
      disposeLinks();
    };
  }, [bridge]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates the desktop tab when a ThreadPage link arrives while the page is open
  useEffect(() => {
    if (url === undefined || url === openedUrlRef.current) return;
    openedUrlRef.current = url;
    withDesktopTab(THREAD_PAGE_TAB_ID, () => bridge.navigate(THREAD_PAGE_TAB_ID, url));
  }, [bridge, url]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the webview's webContents with the desktop bridge and watches for a crashed guest
  useEffect(() => {
    const webview = webviewRef.current;
    if (!clientSettingsHydrated || !config || !webview) return;
    let disposed = false;
    const register = () => {
      const lease = leaseRef.current;
      if (!lease) return;
      void (async () => {
        try {
          // The tab is created asynchronously; registering earlier fails with PreviewTabNotFoundError.
          await lease.ready;
          if (disposed) return;
          let webContentsId: number;
          try {
            webContentsId = webview.getWebContentsId();
          } catch {
            // Not attached yet; did-attach registers it.
            return;
          }
          if (Number.isInteger(webContentsId) && webContentsId > 0) {
            await bridge.registerWebview(THREAD_PAGE_TAB_ID, webContentsId);
          }
        } catch (error) {
          console.error("Failed to register the ThreadPage webview", error);
        }
      })();
    };
    const markCrashed = () => setCrashed(true);
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    webview.addEventListener("render-process-gone", markCrashed);
    register();
    return () => {
      disposed = true;
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      webview.removeEventListener("render-process-gone", markCrashed);
    };
  }, [
    bridge,
    clientSettingsHydrated,
    config,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reloading after a crash remounts the webview under a new key, so the listeners attach to the new element.
    webviewGeneration,
  ]);

  const navStatus = tab?.navStatus;
  const currentUrl =
    navStatus && navStatus.kind !== "Idle" && isThreadPageUrl(navStatus.url)
      ? navStatus.url
      : THREAD_PAGE_APP_URL;
  const loading = navStatus?.kind === "Loading";
  const loadFailed = navStatus?.kind === "LoadFailed" ? navStatus : null;
  const reload = () => {
    if (crashed) {
      setCrashed(false);
      setTab(null);
      setWebviewGeneration((generation) => generation + 1);
      return;
    }
    void bridge.refresh(THREAD_PAGE_TAB_ID);
  };

  const controls = (
    <>
      <HeaderIconButton
        label="Back"
        disabled={!tab?.canGoBack || crashed}
        onClick={() => void bridge.goBack(THREAD_PAGE_TAB_ID)}
      >
        <ArrowLeftIcon />
      </HeaderIconButton>
      <HeaderIconButton
        label="Forward"
        disabled={!tab?.canGoForward || crashed}
        onClick={() => void bridge.goForward(THREAD_PAGE_TAB_ID)}
      >
        <ArrowRightIcon />
      </HeaderIconButton>
      <HeaderIconButton label="Reload" busy={loading} disabled={tab === null} onClick={reload}>
        <RefreshIcon size="sm" refreshing={loading} />
      </HeaderIconButton>
      <HeaderIconButton label="Open in browser" onClick={() => openInSystemBrowser(currentUrl)}>
        <ExternalLinkIcon />
      </HeaderIconButton>
    </>
  );

  const failure = crashed
    ? { title: "ThreadPage stopped", description: "The page crashed. Reload to open it again." }
    : loadFailed
      ? {
          title: "ThreadPage didn't load",
          description: loadFailed.description || "Check your connection and reload.",
        }
      : null;

  return (
    <ThreadPageShell controls={controls}>
      <div className="relative min-h-0 flex-1">
        {clientSettingsHydrated && config ? (
          <webview
            key={webviewGeneration}
            ref={(node: HTMLElement | null) => {
              webviewRef.current = node as HTMLElementTagNameMap["webview"] | null;
            }}
            // Electron reads allowpopups at attachment, and React drops boolean values for unknown attributes.
            // Sign-in popups need it; the desktop tab's window-open handler still vets every popup.
            {...({ allowpopups: "true" } as unknown as { readonly allowpopups?: boolean })}
            src={initialUrl}
            partition={config.partition}
            webpreferences={config.webPreferences}
            {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
            data-preview-tab={THREAD_PAGE_TAB_ID}
            className="absolute inset-0 flex bg-background"
          />
        ) : null}
        {/* Until the tab reports in, the body would be blank with every control disabled. */}
        {tab === null && failure === null ? (
          <p
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground text-sm"
          >
            Opening ThreadPage…
          </p>
        ) : null}
        {failure ? (
          <div className="absolute inset-0 flex bg-background">
            <Empty role="status">
              <TriangleAlertIcon aria-hidden className="size-5 text-warning" />
              <EmptyHeader>
                <EmptyTitle>{failure.title}</EmptyTitle>
                <EmptyDescription>{failure.description}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" onClick={reload}>
                  <RefreshIcon />
                  Reload
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        ) : null}
      </div>
    </ThreadPageShell>
  );
}

export function ThreadPagePage({ url }: { readonly url?: string | undefined }) {
  return previewBridge ? (
    <ThreadPageBrowser bridge={previewBridge} url={url} />
  ) : (
    <ThreadPageOpensInNewTab />
  );
}
