import type { ProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ListFilterIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { isElectron } from "../../env";
import { useEnvironmentProviderEntries } from "../../hooks/useEnvironmentProviderEntries";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SkillSourceBadge, skillSourcePresentation } from "../chat/SkillSourceBadge";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import type { SidebarMachine } from "../sidebar/SidebarFolderHeader";
import { useSidebarMachines } from "../sidebar/useSidebarMachines";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildSkillsView,
  collectProviderSkills,
  countActiveSkillFilters,
  type SkillAgentGroup,
  type SkillMachineColumn,
  type SkillRowModel,
  type SkillsSearch,
  type SkillsView,
  validateSkillsSearch,
} from "./skillsPage.logic";

const COLLAPSED_AGENTS_KEY = "t3code:skills:collapsed-agents";
const CollapsedAgents = Schema.Array(Schema.String);
const ALL_STATUSES = "all";

type View = SkillsView<SidebarMachine, ProviderInstanceEntry>;
type UpdateSearch = (patch: {
  readonly [Key in keyof SkillsSearch]?: SkillsSearch[Key] | undefined;
}) => void;

function toggled<Value extends string>(
  hidden: ReadonlyArray<Value> | undefined,
  value: Value,
  shown: boolean,
): ReadonlyArray<Value> | undefined {
  const next = shown ? (hidden ?? []).filter((item) => item !== value) : [...(hidden ?? []), value];
  return next.length > 0 ? next : undefined;
}

function SkillRow(props: { readonly row: SkillRowModel }) {
  const { skill, source, missingOn } = props.row;
  const description = skill.shortDescription ?? skill.description;
  return (
    <li className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate font-medium text-sm">
          {formatProviderSkillDisplayName(skill)}
        </span>
        <SkillSourceBadge kind={source} />
        {skill.enabled ? null : (
          <Badge size="sm" variant="outline">
            Disabled
          </Badge>
        )}
        {skill.userInvocable === false ? (
          <Badge size="sm" variant="outline">
            Agent only
          </Badge>
        ) : null}
        {missingOn.length > 0 ? (
          <Badge size="sm" variant="warning">
            Not on {missingOn.join(", ")}
          </Badge>
        ) : null}
      </div>
      {description ? (
        <p className="line-clamp-2 text-muted-foreground text-xs">{description}</p>
      ) : null}
      <div className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
        <code className="flex min-w-0 font-mono text-2xs">
          <MiddleTruncate value={skill.path} />
        </code>
        <DiffFilePathCopyButton filePath={skill.path} />
      </div>
    </li>
  );
}

function SkillAgentSection(props: {
  readonly group: SkillAgentGroup<ProviderInstanceEntry>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { group } = props;
  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <section className="flex min-w-0 flex-col gap-2">
        <h3>
          <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                props.open && "rotate-90",
              )}
            />
            <ProviderInstanceIcon
              driverKind={group.provider.driverKind}
              displayName={group.provider.displayName}
              accentColor={group.provider.accentColor}
              acpRegistryIconUrl={group.provider.acpRegistryIconUrl}
              size="compact"
            />
            <span className="min-w-0 truncate">{group.provider.displayName}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {group.skills.length}
            </span>
          </CollapsibleTrigger>
        </h3>
        {/* Lists run to hundreds of rows, so they open at once instead of animating height. */}
        <CollapsiblePanel animate={false}>
          <ul className="divide-y rounded-lg border">
            {group.skills.map((row) => (
              <SkillRow key={row.skill.path} row={row} />
            ))}
          </ul>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}

function SkillAgentSections(props: {
  readonly groups: ReadonlyArray<SkillAgentGroup<ProviderInstanceEntry>>;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (agentKey: string, open: boolean) => void;
}) {
  return props.groups.map((group) => (
    <SkillAgentSection
      key={group.key}
      group={group}
      open={!props.collapsed.has(group.key)}
      onOpenChange={(open) => props.onToggle(group.key, open)}
    />
  ));
}

function columnEmptyText(column: SkillMachineColumn<SidebarMachine, ProviderInstanceEntry>) {
  if (column.available > 0) return "No skills match.";
  return column.machine.disconnected
    ? "Offline. Its skills show up once it reconnects."
    : "No skills on this machine.";
}

function SkillMachineColumnView(props: {
  readonly column: SkillMachineColumn<SidebarMachine, ProviderInstanceEntry>;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (agentKey: string, open: boolean) => void;
}) {
  const { column } = props;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <h2
        id={headingId}
        className="flex min-w-0 items-center gap-2 border-b pb-2 font-semibold text-sm"
      >
        <EnvironmentMachineIcon
          aria-hidden
          kind={column.machine.machineKind}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate">{column.machine.label}</span>
        {column.machine.disconnected ? (
          <span className="shrink-0 font-normal text-muted-foreground text-xs">Offline</span>
        ) : null}
        <span className="ml-auto shrink-0 font-normal text-muted-foreground text-xs tabular-nums">
          {column.shown === column.available
            ? column.shown
            : `${column.shown} of ${column.available}`}
        </span>
      </h2>
      {column.groups.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          {columnEmptyText(column)}
        </p>
      ) : (
        <SkillAgentSections
          groups={column.groups}
          collapsed={props.collapsed}
          onToggle={props.onToggle}
        />
      )}
    </section>
  );
}

function SkillFiltersMenu(props: {
  readonly view: View;
  readonly machines: ReadonlyArray<SidebarMachine>;
  readonly search: SkillsSearch;
  readonly updateSearch: UpdateSearch;
}) {
  const { view, machines, search, updateSearch } = props;
  const activeCount = countActiveSkillFilters(search);
  const hiddenAgents = new Set(search.hideAgent);
  const hiddenSources = new Set<ProviderSkillSourceKind>(search.hideSource);
  const hiddenMachines = new Set<string>(search.hideMachine);
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <ListFilterIcon aria-hidden />
        <span className="max-sm:sr-only">Filters</span>
        {activeCount > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-muted-foreground text-xs tabular-nums">
            {activeCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" className="w-60">
        {view.agents.length > 1 ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Agents</MenuGroupLabel>
              {view.agents.map(({ key, provider }) => (
                <MenuCheckboxItem
                  key={key}
                  checked={!hiddenAgents.has(key)}
                  onCheckedChange={(checked) =>
                    updateSearch({ hideAgent: toggled(search.hideAgent, key, checked) })
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderInstanceIcon
                      driverKind={provider.driverKind}
                      displayName={provider.displayName}
                      accentColor={provider.accentColor}
                      acpRegistryIconUrl={provider.acpRegistryIconUrl}
                      size="compact"
                    />
                    <span className="min-w-0 truncate">{provider.displayName}</span>
                  </span>
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        {view.sources.length > 1 ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Source</MenuGroupLabel>
              {view.sources.map((source) => {
                const { Icon, label } = skillSourcePresentation(source);
                return (
                  <MenuCheckboxItem
                    key={source}
                    checked={!hiddenSources.has(source)}
                    onCheckedChange={(checked) =>
                      updateSearch({ hideSource: toggled(search.hideSource, source, checked) })
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon aria-hidden className="size-3.5 text-muted-foreground" />
                      {label}
                    </span>
                  </MenuCheckboxItem>
                );
              })}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuRadioGroup
          value={search.status ?? ALL_STATUSES}
          onValueChange={(next) =>
            updateSearch({ status: next === "enabled" || next === "disabled" ? next : undefined })
          }
        >
          <MenuGroupLabel>Status</MenuGroupLabel>
          <MenuRadioItem value={ALL_STATUSES}>Any</MenuRadioItem>
          <MenuRadioItem value="enabled">Enabled</MenuRadioItem>
          <MenuRadioItem value="disabled">Disabled</MenuRadioItem>
        </MenuRadioGroup>
        {machines.length > 1 ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Machines</MenuGroupLabel>
              {machines.map((machine) => (
                <MenuCheckboxItem
                  key={machine.environmentId}
                  checked={!hiddenMachines.has(machine.environmentId)}
                  onCheckedChange={(checked) =>
                    updateSearch({
                      hideMachine: toggled(search.hideMachine, machine.environmentId, checked),
                    })
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={machine.machineKind}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 truncate">{machine.label}</span>
                  </span>
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={search.missing === true}
              disabled={!view.comparing}
              onCheckedChange={(checked) => updateSearch({ missing: checked ? true : undefined })}
            >
              Only skills another machine lacks
            </MenuCheckboxItem>
          </>
        ) : null}
        {activeCount > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                updateSearch({
                  status: undefined,
                  hideAgent: undefined,
                  hideSource: undefined,
                  hideMachine: undefined,
                  missing: undefined,
                })
              }
            >
              Clear filters
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function SkillsPage() {
  const machines = useSidebarMachines();
  const providerEntries = useEnvironmentProviderEntries();
  const search = useSearch({ from: "/_chat/skills" });
  const navigate = useNavigate({ from: "/skills" });
  // The field keeps what is typed while focused; the address catches up a moment later.
  const [typedQuery, setTypedQuery] = useState<string | null>(null);
  const query = typedQuery ?? search.q ?? "";
  const [collapsedAgents, setCollapsedAgents] = useLocalStorage(
    COLLAPSED_AGENTS_KEY,
    [],
    CollapsedAgents,
  );
  const collapsed = new Set(collapsedAgents);

  const updateSearch: UpdateSearch = (patch) =>
    void navigate({
      search: (previous) => validateSkillsSearch({ ...previous, ...patch }),
      replace: true,
      resetScroll: false,
    });

  const entriesByEnvironment = new Map(
    providerEntries.map(({ environmentId, entries }) => [environmentId, entries]),
  );
  const view: View = buildSkillsView({
    machines: machines.map((machine) => ({
      machine,
      agents: (entriesByEnvironment.get(machine.environmentId) ?? []).map((provider) => ({
        key: provider.instanceId,
        provider,
        skills: collectProviderSkills(provider.snapshot),
      })),
    })),
    search: { ...search, q: query },
  });
  const multipleMachines = machines.length > 1;
  const filtered = query.trim() !== "" || countActiveSkillFilters(search) > 0;
  // Collapsing an agent folds it in every column, so the machines stay side by side.
  const toggleAgent = (agentKey: string, open: boolean) =>
    setCollapsedAgents((current) =>
      open ? current.filter((key) => key !== agentKey) : [...new Set([...current, agentKey])],
    );
  const allCollapsed = view.agents.every((agent) => collapsed.has(agent.key));

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Skills breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Skills</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {view.total > 0 ? (
            <div className="ml-auto flex items-center gap-2">
              <InputGroup className="w-40 sm:w-56">
                <InputGroupAddon>
                  <SearchIcon aria-hidden className="size-3" />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search skills"
                  placeholder={`Search ${view.total} skills`}
                  size="sm"
                  value={query}
                  onFocus={() => setTypedQuery(search.q ?? "")}
                  onBlur={() => setTypedQuery(null)}
                  onChange={(event) => {
                    setTypedQuery(event.currentTarget.value);
                    updateSearch({ q: event.currentTarget.value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || query.length === 0) return;
                    event.preventDefault();
                    setTypedQuery("");
                    updateSearch({ q: undefined });
                  }}
                />
              </InputGroup>
              <SkillFiltersMenu
                view={view}
                machines={machines}
                search={search}
                updateSearch={updateSearch}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label={allCollapsed ? "Expand all agents" : "Collapse all agents"}
                      onClick={() =>
                        setCollapsedAgents(
                          allCollapsed ? [] : view.agents.map((agent) => agent.key),
                        )
                      }
                    />
                  }
                >
                  {allCollapsed ? (
                    <ChevronsUpDownIcon aria-hidden />
                  ) : (
                    <ChevronsDownUpIcon aria-hidden />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  {allCollapsed ? "Expand all" : "Collapse all"}
                </TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </WorkspacePageHeader>
        {view.total === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SparklesIcon />
              </EmptyMedia>
              <EmptyTitle>No skills found</EmptyTitle>
              <EmptyDescription>
                Skills are folders with a SKILL.md that agents load when a task calls for them.
                Install one for Claude, Codex, or another agent and it shows up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width={multipleMachines ? "full" : "wide"}>
              {view.shown === 0 && filtered ? (
                <div role="status" className="flex flex-col items-center gap-3 py-10 text-center">
                  <p className="text-muted-foreground text-sm">
                    {query.trim() === ""
                      ? "No skills match these filters."
                      : `No skills match “${query.trim()}”.`}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setTypedQuery(null);
                      void navigate({ search: {}, replace: true, resetScroll: false });
                    }}
                  >
                    Clear search and filters
                  </Button>
                </div>
              ) : multipleMachines ? (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(22rem,100%),1fr))] items-start gap-6">
                  {view.columns.map((column) => (
                    <SkillMachineColumnView
                      key={column.machine.environmentId}
                      column={column}
                      collapsed={collapsed}
                      onToggle={toggleAgent}
                    />
                  ))}
                </div>
              ) : (
                <SkillAgentSections
                  groups={view.columns[0]?.groups ?? []}
                  collapsed={collapsed}
                  onToggle={toggleAgent}
                />
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}
