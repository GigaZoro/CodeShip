import {
  type MonitoringFindingCode,
  MonitoringFixChatError,
  type MonitoringFixChatFailure,
  type MonitoringFixChatInput,
  type MonitoringFixChatResult,
  type MonitoringThreadSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeStartChatAsUser } from "../orchestration-v2/startChatAsUser.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as Monitoring from "./MonitoringService.ts";
import {
  APPROVAL_WAIT_MS,
  CONTEXT_PRESSURE_RATIO,
  DELEGATE_WAIT_MS,
  FAILING_COMMANDS_MIN_COUNT,
  LONG_QUEUE_MS,
  LOW_CACHE_REUSE_RATIO,
  MANY_PROMPTS,
  MINUTE_MS,
  REPEATED_COMMAND_MIN_COUNT,
  SLOW_COMMAND_MS,
} from "./ThreadAnalyzer.ts";

export class MonitoringFixChats extends Context.Service<
  MonitoringFixChats,
  {
    /**
     * Starts a chat that traces one weak point in the given chats to its root cause and fixes it,
     * in the project that lost the most time to it.
     */
    readonly start: (input: MonitoringFixChatInput) => Effect.Effect<
      /** `resumed` when this request repeats one that already started the chat. */
      MonitoringFixChatResult & { readonly resumed: boolean },
      MonitoringFixChatError
    >;
  }
>()("t3/monitoring/MonitoringFixChats") {}

interface WeakPointText {
  readonly title: string;
  /** What the analyzer counted, worded with its own thresholds. */
  readonly definition: string;
  /** What a finding's count counts; null when the count is not shown. */
  readonly counted: string | null;
  /** Names a finding's detail; null when the finding has none. */
  readonly detail: ((detail: string) => string) | null;
}

const minutes = (ms: number) => `${ms / MINUTE_MS} minutes`;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

const WEAK_POINT_TEXT: Readonly<Record<MonitoringFindingCode, WeakPointText>> = {
  usage_limit: {
    title: "Stopped by usage limits",
    definition: "The chat stood still until a usage limit lifted.",
    counted: "usage-limit errors",
    detail: null,
  },
  run_failures: {
    title: "Runs failed",
    definition: "Provider, network or other errors ended runs.",
    counted: "failed runs",
    detail: (detail) => `most common error: ${detail}`,
  },
  retries: {
    title: "Runs retried",
    definition: "Runs were retried or recovered after provider trouble.",
    counted: "retries",
    detail: null,
  },
  steering_restarts: {
    title: "Restarted to steer",
    definition: "A message sent while a run was going restarted the work.",
    counted: "restarts",
    detail: null,
  },
  user_interrupts: {
    title: "Stopped by hand",
    definition: "I stopped runs by hand, usually because the agent went the wrong way.",
    counted: "stopped runs",
    detail: null,
  },
  long_queue: {
    title: "Waited in the queue",
    definition: `Runs waited ${minutes(LONG_QUEUE_MS)} or more in all to start behind other work.`,
    counted: "runs that waited a minute or more",
    detail: null,
  },
  slow_command: {
    title: "Slow commands",
    definition: `Single commands ran ${minutes(SLOW_COMMAND_MS)} or more.`,
    counted: "slow commands",
    detail: (detail) => `slowest command: ${detail}`,
  },
  repeated_command: {
    title: "Same command again and again",
    definition: `One command line ran ${REPEATED_COMMAND_MIN_COUNT} or more times; reads, searches and git commands are not counted.`,
    counted: "runs of it",
    detail: (detail) => `command: ${detail}`,
  },
  failing_commands: {
    title: "Failing commands",
    definition: `Commands failed ${FAILING_COMMANDS_MIN_COUNT} or more times; reads, searches and git commands are not counted.`,
    counted: "failed commands",
    detail: null,
  },
  approval_wait: {
    title: "Waited on approvals",
    definition: `Runs paused ${minutes(APPROVAL_WAIT_MS)} or more in all for approvals or my answers.`,
    counted: "requests",
    detail: null,
  },
  delegate_wait: {
    title: "Waited on helpers",
    definition: `The chat sat idle ${minutes(DELEGATE_WAIT_MS)} or more while delegates, subagents or background commands ran.`,
    counted: "helpers",
    detail: null,
  },
  low_cache_reuse: {
    title: "Low prompt-cache reuse",
    definition: `Less than ${percent(LOW_CACHE_REUSE_RATIO)} of the input came from the prompt cache.`,
    counted: null,
    detail: (detail) => `cache reuse ${detail}%`,
  },
  context_compacted: {
    title: "Context compacted",
    definition: "The context window filled up, so the agent went on from a summary.",
    counted: "compactions",
    detail: null,
  },
  context_pressure: {
    title: "Context nearly full",
    definition: `The context window reached ${percent(CONTEXT_PRESSURE_RATIO)} full or more.`,
    counted: null,
    detail: (detail) => `peak context ${detail}%`,
  },
  many_prompts: {
    title: "Lots of back-and-forth",
    definition: `I sent ${MANY_PROMPTS} or more prompts; the time waiting for me counts as lost.`,
    counted: "prompts",
    detail: null,
  },
  reopened: {
    title: "Reopened after settling",
    definition: "The chat was settled before its work was done and had to be reopened.",
    counted: "reopens",
    detail: null,
  },
};

const failure = (reason: MonitoringFixChatFailure, detail: string) =>
  new MonitoringFixChatError({ reason, detail });

interface Hit {
  readonly chat: MonitoringThreadSummary;
  readonly count: number;
  readonly wastedMs: number;
  readonly detail: string | null;
}

/** Projects by the time the weak point cost them, then by how many chats it hit. */
function projectsByLoss(hits: ReadonlyArray<Hit>): ReadonlyArray<ProjectId> {
  const totals = new Map<ProjectId, { wastedMs: number; chats: number }>();
  for (const hit of hits) {
    const total = totals.get(hit.chat.projectId) ?? { wastedMs: 0, chats: 0 };
    totals.set(hit.chat.projectId, {
      wastedMs: total.wastedMs + hit.wastedMs,
      chats: total.chats + 1,
    });
  }
  return [...totals.entries()]
    .toSorted(([, left], [, right]) => right.wastedMs - left.wastedMs || right.chats - left.chats)
    .map(([projectId]) => projectId);
}

function chatLine(
  hit: Hit,
  text: WeakPointText,
  projectTitles: ReadonlyMap<ProjectId, string>,
): string {
  const project = projectTitles.get(hit.chat.projectId) ?? "a project that no longer exists";
  const facts = [
    ...(text.counted !== null && hit.count > 0 ? [`${hit.count} ${text.counted}`] : []),
    ...(hit.wastedMs > 0 ? [`${formatDuration(hit.wastedMs)} lost`] : []),
    ...(text.detail !== null && hit.detail !== null ? [text.detail(hit.detail)] : []),
  ];
  const where = `thread ${hit.chat.threadId}, project ${project}, settled ${hit.chat.settledAt.slice(0, 10)}`;
  return `- "${hit.chat.title}" (${where})${facts.length > 0 ? `: ${facts.join("; ")}` : ""}`;
}

/** The chat's first message. It is sent as the user, so it speaks in the first person. */
function monitoringFixChatMessage(
  code: MonitoringFindingCode,
  hits: ReadonlyArray<Hit>,
  projectTitles: ReadonlyMap<ProjectId, string>,
): string {
  const text = WEAK_POINT_TEXT[code];
  const lostMs = hits.reduce((sum, hit) => sum + hit.wastedMs, 0);
  const scope = `${hits.length === 1 ? "1 chat" : `${hits.length} chats`}${lostMs > 0 ? `, ${formatDuration(lostMs)} lost in all` : ""}`;
  return [
    "Monitoring found a weak point in my chats. Trace it to its root cause and fix it there.",
    "",
    `Weak point: ${text.title}`,
    `What it means: ${text.definition}`,
    `Found in: ${scope}`,
    "",
    "Chats, most time lost first:",
    ...hits.map((hit) => chatLine(hit, text, projectTitles)),
    "",
    "Read these chats first (t3_thread_read takes the thread id) and find what made this happen. The cause can be in a project's code, scripts or tests, in the agent instructions, rules or skills that steered the agent, or in T3.CodeShip itself.",
    "Fix it where it starts, in every place it shows up, and add what keeps it from coming back unnoticed. If it was a one-off with nothing to fix, say why instead of changing anything.",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const monitoring = yield* Monitoring.MonitoringService;
  const projects = yield* Project.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const startChatAsUser = yield* makeStartChatAsUser;

  const start: MonitoringFixChats["Service"]["start"] = Effect.fn("MonitoringFixChats.start")(
    function* (input) {
      const chats = yield* monitoring
        .summaries([...new Set(input.threadIds)])
        .pipe(Effect.mapError((error) => failure("launch-failed", error.message)));
      const hits = chats
        .flatMap((chat): ReadonlyArray<Hit> => {
          const finding = chat.findings.find((candidate) => candidate.code === input.code);
          return finding === undefined
            ? []
            : [{ chat, count: finding.count, wastedMs: finding.wastedMs, detail: finding.detail }];
        })
        .toSorted((left, right) => right.wastedMs - left.wastedMs);
      if (hits.length === 0) {
        return yield* failure(
          "no-chats",
          "None of these chats still shows this weak point. Monitoring may have analyzed them again.",
        );
      }
      const projectTitles = new Map<ProjectId, string>();
      for (const projectId of new Set(hits.map((hit) => hit.chat.projectId))) {
        const project = yield* projects
          .getById(projectId)
          .pipe(Effect.mapError(() => failure("launch-failed", "Could not read the project.")));
        if (Option.isSome(project)) projectTitles.set(projectId, project.value.title);
      }
      // The project that lost the most time is where the cause most likely lives; the chat can
      // still reach the others. Chats whose projects are all gone fall back to No project.
      const projectId =
        projectsByLoss(hits).find((candidate) => projectTitles.has(candidate)) ??
        (yield* managedFolders.ensureScratchProject.pipe(
          Effect.mapError((error) => failure("launch-failed", error.message)),
        )).projectId;
      return yield* startChatAsUser({
        commandId: input.commandId,
        projectId,
        title: `Fix weak point: ${WEAK_POINT_TEXT[input.code].title}`,
        text: monitoringFixChatMessage(input.code, hits, projectTitles),
        creationSource: input.creationSource ?? "web",
      }).pipe(Effect.mapError((error) => failure(error.reason, error.detail)));
    },
    (effect, input) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Monitoring fix chat was not started", {
            code: input.code,
            reason: error.reason,
            detail: error.detail,
          }),
        ),
      ),
  );

  return MonitoringFixChats.of({ start });
});

export const layer = Layer.effect(MonitoringFixChats, make);
