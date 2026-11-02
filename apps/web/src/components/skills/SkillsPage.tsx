import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import type { EnvironmentId, ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { SearchIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useEnvironmentProviderEntries } from "../../hooks/useEnvironmentProviderEntries";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SkillSourceBadge } from "../chat/SkillSourceBadge";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { settingsScopeEnvironmentLabel } from "../settings/settingsScopeAxis";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

interface ProviderSkills {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ProviderInstanceEntry;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

/** The provider's own skills plus those found in the project folders it has opened. */
function collectSkills(provider: ProviderInstanceEntry): ReadonlyArray<ServerProviderSkill> {
  const byPath = new Map<string, ServerProviderSkill>();
  const snapshots = provider.snapshot.workspaceSnapshots ?? [];
  for (const skill of [provider.snapshot.skills, ...snapshots.map((s) => s.skills)].flat()) {
    if (!byPath.has(skill.path)) byPath.set(skill.path, skill);
  }
  return [...byPath.values()].toSorted((left, right) =>
    formatProviderSkillDisplayName(left).localeCompare(formatProviderSkillDisplayName(right)),
  );
}

function matchesQuery(skill: ServerProviderSkill, query: string) {
  if (query === "") return true;
  return [
    skill.name,
    skill.displayName ?? "",
    skill.shortDescription ?? "",
    skill.description ?? "",
  ].some((text) => text.toLocaleLowerCase().includes(query));
}

function SkillRow(props: { readonly skill: ServerProviderSkill }) {
  const { skill } = props;
  const description = skill.shortDescription ?? skill.description;
  return (
    <li className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate font-medium text-sm">
          {formatProviderSkillDisplayName(skill)}
        </span>
        <SkillSourceBadge kind={resolveProviderSkillSourceKind(skill)} />
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

export function SkillsPage() {
  const { environments } = useEnvironments();
  const providerEntries = useEnvironmentProviderEntries();
  const [query, setQuery] = useState("");
  const foldedQuery = query.trim().toLocaleLowerCase();
  const multipleEnvironments = providerEntries.length > 1;

  const groups: Array<ProviderSkills> = providerEntries.flatMap(({ environmentId, entries }) =>
    entries.flatMap((provider) => {
      const skills = collectSkills(provider);
      return skills.length === 0
        ? []
        : [{ key: `${environmentId}:${provider.instanceId}`, environmentId, provider, skills }];
    }),
  );
  const total = groups.reduce((count, group) => count + group.skills.length, 0);
  const shown = groups
    .map((group) => ({
      ...group,
      skills: group.skills.filter((skill) => matchesQuery(skill, foldedQuery)),
    }))
    .filter((group) => group.skills.length > 0);
  const environmentLabel = (environmentId: EnvironmentId) => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    return environment ? settingsScopeEnvironmentLabel(environment, environments) : null;
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Skills breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>Skills</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {total === 0 ? (
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
            <WorkspacePageContainer width="wide">
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search skills"
                  placeholder={`Search ${total} skills`}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              </InputGroup>
              {shown.length === 0 ? (
                <p className="text-muted-foreground text-sm">No skills match “{query}”.</p>
              ) : (
                shown.map((group) => {
                  const machine = multipleEnvironments
                    ? environmentLabel(group.environmentId)
                    : null;
                  return (
                    <section key={group.key} aria-labelledby={`skills-${group.key}`}>
                      <h2
                        id={`skills-${group.key}`}
                        className="mb-2 flex items-center gap-2 font-medium text-sm"
                      >
                        <ProviderInstanceIcon
                          driverKind={group.provider.driverKind}
                          displayName={group.provider.displayName}
                          accentColor={group.provider.accentColor}
                          acpRegistryIconUrl={group.provider.acpRegistryIconUrl}
                          size="compact"
                        />
                        <span className="min-w-0 truncate">
                          {group.provider.displayName}
                          {machine ? (
                            <span className="text-muted-foreground"> · {machine}</span>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {group.skills.length}
                        </span>
                      </h2>
                      <ul className="divide-y rounded-lg border">
                        {group.skills.map((skill) => (
                          <SkillRow key={skill.path} skill={skill} />
                        ))}
                      </ul>
                    </section>
                  );
                })
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}
