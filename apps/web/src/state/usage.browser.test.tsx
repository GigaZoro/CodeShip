import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  mergeAnsweredUsage,
  retainedUsageLabel,
  usageEnvironmentError,
} from "@t3tools/client-runtime/state/usage-progress";
import { UsageShareBar } from "../components/usage/UsageShareBar";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useUsage, type EnvironmentUsageStatus } from "./usage";

const state = vi.hoisted(() => ({ environments: [] as readonly EnvironmentUsageStatus[] }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.environments }));
vi.mock("@t3tools/client-runtime/state/usage", () => ({
  needsCursorKeychainAccess: () => false,
  refreshUsage: vi.fn(),
  usageSummaryInput: (input: unknown) => input,
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", () => ({ environmentPresentations: {} }));
vi.mock("./query", () => ({ formatEnvironmentQueryError: () => "The request failed." }));
vi.mock("./server", () => ({ serverEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {}, readEnvironmentScope: vi.fn() }));

function setup() {
  const window: UsageSummaryInput = {
    sinceDay: UsageDay.make("2026-10-16"),
    untilDay: UsageDay.make("2026-10-23"),
    timeZone: "UTC",
    resolution: "day",
  };
  const summary: UsageSummary = {
    contractVersion: USAGE_CONTRACT_VERSION,
    ...window,
    readAt: "2026-10-23T12:00:00.000Z",
    buckets: [
      {
        day: window.sinceDay,
        provider: "codex",
        model: "test",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0,
        cacheSavingsUsd: 0,
        costSource: "unpriced",
        records: 1,
        unpricedRecords: 1,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: "test",
          provider: "codex",
          resolvedHomePath: "/transcripts",
          volumeId: "1",
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
  };
  const answered: EnvironmentUsageStatus = {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    isPending: false,
    isConnected: true,
    canReadDiagnostics: true,
    error: null,
    summary,
    needsCursorKeychainAccess: false,
  };
  state.environments = [answered];
  return { window, answered, summary };
}

function UsageProbe({
  window,
  selection,
}: {
  readonly window: UsageSummaryInput;
  readonly selection?: ReadonlySet<EnvironmentId>;
}) {
  return <UsageProbeResult usage={useUsage(window, selection)} />;
}

function UsageProbeResult({ usage }: { readonly usage: ReturnType<typeof useUsage> }) {
  const error = usage.shown?.environments[0];
  return (
    <>
      <output>
        {usage.shown === null
          ? "Loading usage"
          : `${usage.shown.window.resolution ?? "day"} usage: ${usage.selectedEnvironments[0]?.error ?? "ready"}`}
      </output>
      <output>{usage.shown?.window.sinceDay ?? "No shown window"}</output>
      {error === undefined ? null : <p>{usageEnvironmentError(error)}</p>}
      {usage.shown?.environments.some(({ summary }) => summary !== null) ? (
        <p>{usage.shown.merged.totalTokens} tokens</p>
      ) : null}
      {usage.showingKept && usage.shown !== null ? <p>{retainedUsageLabel(usage.shown)}</p> : null}
    </>
  );
}

it("keeps the previous resolution until both environments settle", async () => {
  const { window, answered } = setup();
  const other = { ...answered, environmentId: EnvironmentId.make("other"), label: "Other" };
  state.environments = [answered, other];
  await using screen = await render(<UsageProbe window={window} />);
  await expect.element(screen.getByText("day usage: ready")).toBeVisible();

  const next = { ...window, resolution: "hour" } as const;
  state.environments = [answered, { ...other, summary: null, isPending: true }];
  await screen.rerender(<UsageProbe window={next} />);
  await expect.element(screen.getByText("day usage: ready")).toBeVisible();

  state.environments = [answered, { ...other, summary: null, error: "unavailable" }];
  await screen.rerender(<UsageProbe window={next} />);
  await expect.element(screen.getByText("hour usage: ready")).toBeVisible();
});

it("labels whose figures are retained when switching environments and never keeps an empty selection", async () => {
  const { window, answered, summary } = setup();
  const other = {
    ...answered,
    environmentId: EnvironmentId.make("other"),
    label: "Other",
    summary: null,
    isPending: true,
  };
  state.environments = [answered, other];
  const testSelection = new Set([answered.environmentId]);
  const otherSelection = new Set([other.environmentId]);
  await using screen = await render(<UsageProbe window={window} selection={testSelection} />);
  await expect.element(screen.getByText("100 tokens")).toBeVisible();

  await screen.rerender(<UsageProbe window={window} selection={otherSelection} />);
  await expect
    .element(screen.getByText(/Showing previous usage for Test · Oct 16 to Oct 23/))
    .toBeVisible();
  await expect.element(screen.getByText("100 tokens")).toBeVisible();

  await screen.rerender(<UsageProbe window={window} selection={new Set()} />);
  await screen.rerender(<UsageProbe window={window} selection={otherSelection} />);
  await expect.element(screen.getByText("Loading usage")).toBeVisible();
  await expect.element(screen.getByText("0 tokens", { exact: true })).not.toBeInTheDocument();

  state.environments = [
    answered,
    {
      ...other,
      isPending: false,
      summary: {
        ...summary,
        buckets: summary.buckets.map((bucket) => ({
          ...bucket,
          totals: { ...bucket.totals, uncachedInputTokens: 25 },
        })),
      },
    },
  ];
  await screen.rerender(<UsageProbe window={window} selection={otherSelection} />);
  await expect.element(screen.getByText("25 tokens")).toBeVisible();
  await expect.element(screen.getByText(/Showing previous usage/)).not.toBeInTheDocument();
});

it("shows no priced usage when recorded tokens have zero cost", async () => {
  const { answered } = setup();
  await using screen = await render(
    <UsageShareBar
      label="Cost by type"
      segments={[]}
      format={String}
      recordedUsage={mergeAnsweredUsage([answered])}
      metric="cost"
    />,
  );

  await expect.element(screen.getByText("No priced usage")).toBeVisible();
  await expect.element(screen.getByText("No activity in this window.")).not.toBeInTheDocument();
});

it("renders web Usage with a single failed or offline environment", async () => {
  const { window, answered } = setup();
  state.environments = [{ ...answered, summary: null, error: "Usage scan failed." }];
  await using failed = await render(<UsageProbe window={window} />);
  await expect.element(failed.getByText("Usage scan failed.", { exact: true })).toBeVisible();
  await expect.element(failed.getByText("0 tokens", { exact: true })).not.toBeInTheDocument();

  state.environments = [
    { ...answered, summary: null, isConnected: false, canReadDiagnostics: false },
  ];
  await using offline = await render(<UsageProbe window={window} />);
  await expect.element(offline.getByText("This environment is not connected.")).toBeVisible();
  await expect.element(offline.getByText("0 tokens", { exact: true })).not.toBeInTheDocument();
});
