import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import type { EnvironmentId, ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";

type SkillStatusFilter = "enabled" | "disabled";

export interface SkillsSearch {
  readonly q?: string;
  readonly status?: SkillStatusFilter;
  readonly hideAgent?: ReadonlyArray<string>;
  readonly hideSource?: ReadonlyArray<ProviderSkillSourceKind>;
  readonly hideMachine?: ReadonlyArray<string>;
  /** Only skills some other shown machine's copy of the same agent lacks. */
  readonly missing?: true;
}

const SOURCE_ORDER: Record<ProviderSkillSourceKind, number> = {
  personal: 0,
  project: 1,
  repo: 2,
  app: 3,
  system: 4,
  other: 5,
};

const isSourceKind = (value: string): value is ProviderSkillSourceKind =>
  Object.hasOwn(SOURCE_ORDER, value);

const MAX_QUERY_LENGTH = 200;
const MAX_HIDDEN_VALUES = 50;

function hiddenValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value.filter(
    (item): item is string =>
      typeof item === "string" && item.length > 0 && item.length <= MAX_QUERY_LENGTH,
  );
  return [...new Set(strings)].slice(0, MAX_HIDDEN_VALUES);
}

/** The filters live in the page's address, so going back returns to the same view. */
export function validateSkillsSearch(raw: Record<string, unknown>): SkillsSearch {
  const hideAgent = hiddenValues(raw.hideAgent);
  const hideSource = hiddenValues(raw.hideSource).filter(isSourceKind);
  const hideMachine = hiddenValues(raw.hideMachine);
  return {
    ...(typeof raw.q === "string" && raw.q.trim().length > 0
      ? { q: raw.q.slice(0, MAX_QUERY_LENGTH) }
      : {}),
    ...(raw.status === "enabled" || raw.status === "disabled" ? { status: raw.status } : {}),
    ...(hideAgent.length > 0 ? { hideAgent } : {}),
    ...(hideSource.length > 0 ? { hideSource } : {}),
    ...(hideMachine.length > 0 ? { hideMachine } : {}),
    ...(raw.missing === true ? { missing: true } : {}),
  };
}

export function countActiveSkillFilters(search: SkillsSearch): number {
  return (
    (search.status ? 1 : 0) +
    (search.hideAgent?.length ?? 0) +
    (search.hideSource?.length ?? 0) +
    (search.hideMachine?.length ?? 0) +
    (search.missing ? 1 : 0)
  );
}

interface SkillsMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

interface SkillsAgentInput<Provider> {
  /** Instance ids repeat across machines, so one agent lines up across columns. */
  readonly key: string;
  readonly provider: Provider;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export interface SkillRowModel {
  readonly skill: ServerProviderSkill;
  readonly source: ProviderSkillSourceKind;
  /** Shown machines whose same agent lacks this skill. */
  readonly missingOn: ReadonlyArray<string>;
}

export interface SkillAgentGroup<Provider> {
  readonly key: string;
  readonly provider: Provider;
  readonly skills: ReadonlyArray<SkillRowModel>;
}

export interface SkillMachineColumn<Machine, Provider> {
  readonly machine: Machine;
  /** Before filtering, so an empty column can say whether the machine has skills at all. */
  readonly available: number;
  readonly shown: number;
  readonly groups: ReadonlyArray<SkillAgentGroup<Provider>>;
}

export interface SkillsView<Machine, Provider> {
  readonly total: number;
  readonly shown: number;
  readonly columns: ReadonlyArray<SkillMachineColumn<Machine, Provider>>;
  readonly agents: ReadonlyArray<{ readonly key: string; readonly provider: Provider }>;
  readonly sources: ReadonlyArray<ProviderSkillSourceKind>;
  /** Two or more machines are shown, so skills can be compared between them. */
  readonly comparing: boolean;
}

const skillNameKey = (skill: ServerProviderSkill) => skill.name.toLocaleLowerCase();

// A project's skills travel with its checkout, and only show up once a thread has opened it.
const isMachineWide = (source: ProviderSkillSourceKind) =>
  source !== "project" && source !== "repo";

function matchesQuery(skill: ServerProviderSkill, foldedQuery: string) {
  if (foldedQuery === "") return true;
  return [
    skill.name,
    skill.displayName ?? "",
    skill.shortDescription ?? "",
    skill.description ?? "",
  ].some((text) => text.toLocaleLowerCase().includes(foldedQuery));
}

export function buildSkillsView<Machine extends SkillsMachine, Provider>(input: {
  readonly machines: ReadonlyArray<{
    readonly machine: Machine;
    readonly agents: ReadonlyArray<SkillsAgentInput<Provider>>;
  }>;
  readonly search: SkillsSearch;
}): SkillsView<Machine, Provider> {
  const { search } = input;
  const columns = input.machines.map(({ machine, agents }) => ({
    machine,
    agents: agents.filter((agent) => agent.skills.length > 0),
  }));
  const hiddenMachines = new Set<string>(search.hideMachine);
  const hiddenAgents = new Set(search.hideAgent);
  const hiddenSources = new Set(search.hideSource);
  const visible = columns.filter((column) => !hiddenMachines.has(column.machine.environmentId));
  const namesByMachine = new Map(
    visible.map((column) => [
      column,
      new Map(
        column.agents.map((agent) => [agent.key, new Set(agent.skills.map(skillNameKey))] as const),
      ),
    ]),
  );
  const missingOn = (
    column: (typeof columns)[number],
    agentKey: string,
    skill: ServerProviderSkill,
  ) =>
    visible.flatMap((other) => {
      if (other === column) return [];
      const names = namesByMachine.get(other)?.get(agentKey);
      // A machine without this agent differs by agent, not by skill.
      return names && !names.has(skillNameKey(skill)) ? [other.machine.label] : [];
    });

  const comparing = visible.length > 1;
  const foldedQuery = search.q?.trim().toLocaleLowerCase() ?? "";
  const keep = (agentKey: string, row: SkillRowModel) =>
    !hiddenAgents.has(agentKey) &&
    !hiddenSources.has(row.source) &&
    (search.status === undefined || row.skill.enabled === (search.status === "enabled")) &&
    (!search.missing || !comparing || row.missingOn.length > 0) &&
    matchesQuery(row.skill, foldedQuery);

  const shownColumns = visible.map((column) => {
    const groups = column.agents.flatMap((agent) => {
      const skills = agent.skills
        .map((skill): SkillRowModel => {
          const source = resolveProviderSkillSourceKind(skill);
          return {
            skill,
            source,
            missingOn: isMachineWide(source) ? missingOn(column, agent.key, skill) : [],
          };
        })
        .filter((row) => keep(agent.key, row));
      return skills.length === 0 ? [] : [{ key: agent.key, provider: agent.provider, skills }];
    });
    return {
      machine: column.machine,
      available: column.agents.reduce((count, agent) => count + agent.skills.length, 0),
      shown: groups.reduce((count, group) => count + group.skills.length, 0),
      groups,
    };
  });

  const agents = new Map<string, Provider>();
  const sources = new Set<ProviderSkillSourceKind>();
  let total = 0;
  for (const column of columns) {
    for (const agent of column.agents) {
      if (!agents.has(agent.key)) agents.set(agent.key, agent.provider);
      total += agent.skills.length;
      for (const skill of agent.skills) sources.add(resolveProviderSkillSourceKind(skill));
    }
  }

  return {
    total,
    shown: shownColumns.reduce((count, column) => count + column.shown, 0),
    columns: shownColumns,
    agents: [...agents].map(([key, provider]) => ({ key, provider })),
    sources: [...sources].toSorted((left, right) => SOURCE_ORDER[left] - SOURCE_ORDER[right]),
    comparing,
  };
}

/** The provider's own skills plus those found in the project folders it has opened. */
export function collectProviderSkills(snapshot: {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly workspaceSnapshots?: ReadonlyArray<{
    readonly skills: ReadonlyArray<ServerProviderSkill>;
  }>;
}): ReadonlyArray<ServerProviderSkill> {
  const byPath = new Map<string, ServerProviderSkill>();
  const workspaces = snapshot.workspaceSnapshots ?? [];
  for (const skill of [snapshot.skills, ...workspaces.map((s) => s.skills)].flat()) {
    if (!byPath.has(skill.path)) byPath.set(skill.path, skill);
  }
  return [...byPath.values()].toSorted((left, right) =>
    formatProviderSkillDisplayName(left).localeCompare(formatProviderSkillDisplayName(right)),
  );
}
