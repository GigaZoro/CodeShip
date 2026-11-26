import { t } from "~/i18n";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ActivityIcon,
  BlocksIcon,
  BotIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  KeyRoundIcon,
  MicIcon,
  PaletteIcon,
  ScrollTextIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { resolveEventKeys } from "@t3tools/shared/keybindings";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarInput,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import { useSettingsSectionPrefetch } from "./useSettingsSectionPrefetch";
import {
  isSettingsPageSearchItem,
  searchSettings,
  revealSettingsSearchTarget,
  settingsNavGroups,
  SETTINGS_SEARCH_APP_PAGES,
  SETTINGS_SECTION_LABELS,
  settingsSearchSectionLabel,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import {
  useAvailableSettingsSearchItems,
  useHasSecretProvidersEnvironment,
} from "./useAvailableSettingsSearchItems";
import { handleSettingsSectionKeyDown } from "./settingsSectionNavigation";
import { workspaceAreaProps } from "../../lib/workspaceFocus";

const T3ConnectSidebarSignIn = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarSignIn,
  })),
);
const T3ConnectSidebarAvatar = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/diagnostics": WrenchIcon,
  "/settings/voice": MicIcon,
  "/settings/appearance": PaletteIcon,
  "/settings/chat": MessageSquareTextIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/providers": BotIcon,
  "/settings/threads": MessagesSquareIcon,
  "/settings/browser": GlobeIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/connections": ServerIcon,
  "/settings/secrets": KeyRoundIcon,
  "/settings/maintenance": WrenchIcon,
};

// Detail pages without a nav entry highlight the page that links to them.
const SETTINGS_DETAIL_PAGE_PARENTS: Readonly<Record<string, SettingsPath>> = {
  "/settings/diagnostics": "/settings/maintenance",
  "/settings/open-source-licenses": "/settings/maintenance",
};

// Attached only to the highlighted result, so it runs whenever the highlight lands on a row.
function scrollResultIntoView(row: HTMLElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="size-4 h-5 shrink-0 text-(--sidebar-icon-color)" />;
}

function SettingsSearchResultIcon({ item }: { item: SettingsSearchItem }) {
  if (isSettingsPageSearchItem(item)) return <SettingsSectionIcon to={item.to} />;
  const Icon =
    item.to === "/scheduled-tasks"
      ? CalendarClockIcon
      : item.to === "/usage"
        ? ChartNoAxesColumnIcon
        : item.to === "/monitoring"
          ? ActivityIcon
          : item.to === "/machines"
            ? GaugeIcon
            : item.extensionsTab === "skills"
              ? ScrollTextIcon
              : item.extensionsTab === "mcp"
                ? ServerIcon
                : BlocksIcon;
  return <Icon className="size-4 shrink-0 text-(--sidebar-icon-color)" />;
}

export function SettingsSidebarNav({
  pathname,
  inSidebar = false,
}: {
  pathname: string;
  /** Fills the app sidebar's column, which is already a workspace area. */
  inSidebar?: boolean;
}) {
  const navArea = inSidebar
    ? { "aria-label": t("Settings sections") }
    : workspaceAreaProps("settings-nav", 0, t("Settings sections"));
  const navigate = useNavigate();
  const preloadSection = useSettingsSectionPrefetch();
  const currentHash = useLocation({ select: (location) => location.hash });
  const activePath = SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // Below md the nav is an icon rail; searching expands it over the page.
  const [compactSearchOpen, setCompactSearchOpen] = useState(false);
  const compactLayout = useMediaQuery("max-md");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems();
  const navGroups = settingsNavGroups(useHasSecretProvidersEnvironment());
  const results = searchSettings(query, [...SETTINGS_SEARCH_APP_PAGES, ...searchableItems]);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const maxResultIndex = Math.max(results.length - 1, 0);
  // Persist the clamp so a shrink-then-recover of results keeps the clamped highlight.
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the find and slash search shortcuts
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const eventKeys = resolveEventKeys(event);
      const isFindShortcut =
        eventKeys.has("f") && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      // Shift is allowed only when the layout types "/" with it (German Shift+7); Shift on
      // the physical Slash key types "?" or "," instead.
      const isSlashShortcut =
        eventKeys.has("/") &&
        (event.key === "/" || !event.shiftKey) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          target.closest(
            '[role="dialog"], [aria-modal="true"], [data-slot$="popup"], [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      setCompactSearchOpen(true);
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the search input DOM node after the compact search opens
  useEffect(() => {
    if (compactSearchOpen) searchInputRef.current?.focus();
  }, [compactSearchOpen]);

  const handleSectionClick = (to: SettingsPath) => {
    setCompactSearchOpen(false);
    void navigate({
      to,
      hash: "",
      replace: true,
      hashScrollIntoView: false,
    });
  };

  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    setCompactSearchOpen(false);
    if (!isSettingsPageSearchItem(item)) {
      void (item.to === "/extensions"
        ? navigate({
            to: "/extensions",
            search: item.extensionsTab ? { tab: item.extensionsTab } : {},
          })
        : navigate({ to: item.to }));
      return;
    }
    const targetId = item.targetId ?? item.id;
    revealSettingsSearchTarget(targetId);
    if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    void navigate({
      to: item.to,
      hash: targetId,
      replace: true,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && (query || event.repeat)) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = (activeResultIndex + 1) % results.length;
      setActiveResultIndex(next);
      const result = results[next];
      if (result) preloadSection(result.to);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = (activeResultIndex - 1 + results.length) % results.length;
      setActiveResultIndex(next);
      const result = results[next];
      if (result) preloadSection(result.to);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };

  return (
    <nav
      {...navArea}
      role="navigation"
      // Closes only when focus leaves the nav: pressing a section blurs the search first, and
      // collapsing then would move the rows out from under the press.
      onBlur={(event) => {
        if (isSearching || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setCompactSearchOpen(false);
      }}
      onMouseDown={(event) => {
        // Safari never focuses a pressed button, so the blur above would see no target; keep the
        // search focused instead while its labels are showing.
        if (compactLayout && compactSearchOpen && event.target !== searchInputRef.current) {
          event.preventDefault();
        }
      }}
      className={cn(
        "flex flex-col text-sidebar-foreground",
        inSidebar ? "min-w-0 flex-1" : "w-60 shrink-0 border-e bg-sidebar max-md:w-14",
        !inSidebar &&
          compactSearchOpen &&
          "max-md:absolute max-md:inset-y-0 max-md:start-0 max-md:z-10 max-md:w-full",
      )}
    >
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                !compactSearchOpen && "max-md:hidden",
              )}
            >
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
              {/* Native search inputs clear on Escape even during IME composition. */}
              <SidebarInput
                ref={searchInputRef}
                nativeInput
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                onFocus={() => setCompactSearchOpen(true)}
                placeholder={t("Search")}
                aria-label={t("Search settings")}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
                className="min-w-0 flex-1"
              />
              {isSearching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label={t("Clear settings search")}
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </div>
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {t("No settings found")}
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? t("Settings search results") : undefined}
              >
                {results.map((item, index) => (
                  <SidebarMenuItem
                    key={item.id}
                    role="presentation"
                    ref={index === activeResultIndex ? scrollResultIntoView : undefined}
                  >
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onPointerEnter={() => preloadSection(item.to)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSearchResultIcon item={item} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {t(item.title, item.titleValues)}
                        </span>
                        <span className="block truncate text-2xs text-sidebar-muted-foreground/75">
                          {t(settingsSearchSectionLabel(item.to))}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <div className="flex flex-col gap-4">
                {compactSearchOpen ? null : (
                  <SidebarMenu className="md:hidden">
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label={t("Search settings")}
                        onClick={() => setCompactSearchOpen(true)}
                      >
                        <SearchIcon />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                )}
                <div onKeyDown={handleSettingsSectionKeyDown} className="flex flex-col gap-4">
                  {navGroups.map((group, index) => (
                    <div
                      key={group.heading}
                      className="flex flex-col gap-1 max-md:border-t max-md:border-sidebar-border max-md:pt-4 max-md:first:border-t-0 max-md:first:pt-0"
                    >
                      <h3
                        id={`settings-nav-group-${index}`}
                        className={cn(
                          "px-2 text-xs font-medium text-sidebar-muted-foreground/80",
                          group.headingHidden ? "sr-only" : !compactSearchOpen && "max-md:sr-only",
                        )}
                      >
                        {t(group.heading)}
                      </h3>
                      {/* The heading stays outside the group it names so NVDA does not read the name twice. */}
                      <div role="group" aria-labelledby={`settings-nav-group-${index}`}>
                        <SidebarMenu>
                          {group.paths.map((to) => {
                            const Icon = SETTINGS_SECTION_ICONS[to];
                            const isActive = activePath === to || activePath.startsWith(`${to}/`);
                            return (
                              <SidebarMenuItem key={to}>
                                <SidebarMenuButton
                                  data-settings-section={to}
                                  aria-current={isActive ? "page" : undefined}
                                  isActive={isActive}
                                  onPointerEnter={() => preloadSection(to)}
                                  onFocus={() => preloadSection(to)}
                                  onClick={() => handleSectionClick(to)}
                                >
                                  <Icon />
                                  <span
                                    className={cn(
                                      "truncate",
                                      !compactSearchOpen && "max-md:sr-only",
                                    )}
                                  >
                                    {t(SETTINGS_SECTION_LABELS[to])}
                                  </span>
                                </SidebarMenuButton>
                              </SidebarMenuItem>
                            );
                          })}
                        </SidebarMenu>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="max-md:hidden">
        <Suspense fallback={null}>
          <T3ConnectSidebarSignIn />
        </Suspense>
        <Suspense fallback={null}>
          <T3ConnectSidebarAvatar />
        </Suspense>
      </SidebarFooter>
    </nav>
  );
}
