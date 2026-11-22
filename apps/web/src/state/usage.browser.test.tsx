import {
  AuthDiagnosticsReadScope,
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { mergeAnsweredUsage } from "@t3tools/client-runtime/state/usage-progress";
import {
  retainedUsageLabel,
  usageEnvironmentError,
  usageNotices,
} from "@t3tools/client-runtime/state/usage-view";
import { usageRefreshingEnvironmentIdsAtom } from "@t3tools/client-runtime/state/usage";
import { UsageShareBar } from "../components/usage/UsageShareBar";
import { UsageGapsNotice } from "../components/usage/UsageGapsNotice";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useUsage, type EnvironmentUsageStatus } from "./usage";

const state = vi.hoisted(() => ({
  environments: [] as readonly EnvironmentUsageStatus[],
  query: null as null | ((atom: object) => readonly EnvironmentUsageStatus[]),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: object) =>
    atom === usageRefreshingEnvironmentIdsAtom
      ? new Set()
      : (state.query?.(atom) ?? state.environments),
}));
vi.mock("@t3tools/client-runtime/state/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/usage")>()),
  refreshUsage: vi.fn(),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(
        new Map([
          [
            "desk",
            {
              connection: { phase: "connected", error: null },
              entry: { target: { label: "Desk" } },
            },
          ],
        ]),
      ),
    },
  };
});
vi.mock("./query", () => ({ formatEnvironmentQueryError: () => "The request failed." }));
vi.mock("./server", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      cursorUsageAccessAtom: () =>
        Atom.make({
          history: undefined,
          legacyCanEnable: false,
        }),
      usageSummary: vi.fn(() => Atom.make(AsyncResult.initial())),
      usageModelFilterAtom: () => Atom.make(undefined),
    },
  };
});
vi.mock("./session", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: () =>
        Atom.make(
          AsyncResult.success({
            authenticated: true,
            scopes: [AuthDiagnosticsReadScope],
          }),
        ),
    },
    readEnvironmentScope: vi.fn(),
  };
});

function setup() {
  state.query = null;
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

it("publishes 65-second hourly scans before catching up on the first and subsequent ticks", async () => {
  const { answered, summary } = setup();
  const time = (seconds: number) =>
    makeWindow(1, new Date(Date.parse("2026-11-21T18:56:00Z") + seconds * 1000), "hour");
  const pending = [{ ...answered, summary: null, isPending: true }];
  const requests = new Map<object, readonly EnvironmentUsageStatus[]>();
  state.query = (atom) => {
    if (!requests.has(atom)) requests.set(atom, pending);
    return requests.get(atom)!;
  };
  const complete = (index: number, window: UsageSummaryInput, tokens: number) => {
    const atom = [...requests.keys()][index]!;
    requests.set(atom, [
      {
        ...answered,
        summary: {
          ...summary,
          ...window,
          buckets: summary.buckets.map((bucket) => ({
            ...bucket,
            day: window.sinceDay,
            hourStart: window.sinceTime!,
            totals: { ...bucket.totals, uncachedInputTokens: tokens },
          })),
        },
      },
    ]);
  };
  await using screen = await render(<UsageProbe window={time(0)} />);
  await screen.rerender(<UsageProbe window={time(60)} />);
  expect(requests.size).toBe(1);
  complete(0, time(0), 100);
  await screen.rerender(<UsageProbe window={time(65)} />);
  await expect.element(screen.getByText("100 tokens")).toBeVisible();
  expect(requests.size).toBe(2);

  await screen.rerender(<UsageProbe window={time(120)} />);
  expect(requests.size).toBe(2);
  complete(1, time(65), 200);
  await screen.rerender(<UsageProbe window={time(130)} />);
  await expect.element(screen.getByText("200 tokens")).toBeVisible();
  expect(requests.size).toBe(3);
  await expect.element(screen.getByText(/Showing previous usage/)).not.toBeInTheDocument();
});

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
  const shown = usage.usage.view.kind === "figures" ? usage.usage.view : null;
  const environment = usage.selectedEnvironments[0];
  return (
    <>
      <output>
        {shown === null
          ? "Loading usage"
          : `${shown.window.resolution ?? "day"} usage: ${environment?.error ?? "ready"}`}
      </output>
      <output>{shown?.window.sinceDay ?? "No shown window"}</output>
      {environment === undefined ? null : <p>{usageEnvironmentError(environment)}</p>}
      {shown === null ? null : <p>{shown.merged.totalTokens} tokens</p>}
      {shown?.kept ? <p>{retainedUsageLabel(shown)}</p> : null}
    </>
  );
}

it("keeps two slow hourly scan failures visible until a later response", async () => {
  const { answered, summary } = setup();
  const time = (seconds: number) =>
    makeWindow(1, new Date(Date.parse("2026-11-21T18:56:00Z") + seconds * 1000), "hour");
  const pending = [{ ...answered, summary: null, isPending: true }];
  const requests = new Map<object, readonly EnvironmentUsageStatus[]>();
  state.query = (atom) => {
    if (!requests.has(atom)) requests.set(atom, pending);
    return requests.get(atom)!;
  };
  function Scan({ seconds }: { readonly seconds: number }) {
    const usage = useUsage(time(seconds));
    const { coverage } = usageNotices(
      usage.usage,
      usage.selectedEnvironments,
      usage.requestedWindow,
    );
    return (
      <UsageGapsNotice notice={coverage} retrying={false} onRetry={() => void usage.refresh()} />
    );
  }
  await using screen = await render(<Scan seconds={0} />);
  for (const [i, started] of [0, 120].entries()) {
    await screen.rerender(<Scan seconds={started + 60} />);
    expect(requests.size).toBe(i + 1);
    const atom = [...requests.keys()][i]!;
    const error = `Scan ${i + 1} failed`;
    requests.set(atom, [{ ...answered, summary: null, error }]);
    await screen.rerender(<Scan seconds={started + 65} />);
    expect(requests.size).toBe(i + 1);
    await expect.element(screen.getByText(new RegExp(error))).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    await screen.rerender(<Scan seconds={started + 120} />);
    expect(requests.size).toBe(i + 2);
    await expect.element(screen.getByText(new RegExp(error))).toBeVisible();
  }
  requests.set([...requests.keys()][2]!, [{ ...answered, summary }]);
  await screen.rerender(<Scan seconds={240} />);
  await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});

function ScopedUsage({
  window,
  selection,
}: {
  readonly window: UsageSummaryInput;
  readonly selection?: ReadonlySet<EnvironmentId>;
}) {
  const usage = useUsage(window, selection);
  const { coverage } = usageNotices(usage.usage, usage.selectedEnvironments, usage.requestedWindow);
  return (
    <>
      {usage.usage.view.kind === "figures" ? (
        <p>{usage.usage.view.merged.totalTokens} tokens</p>
      ) : null}
      <UsageGapsNotice notice={coverage} retrying={false} onRetry={() => void usage.refresh()} />
    </>
  );
}

function laptopAnswer(answered: EnvironmentUsageStatus, summary: UsageSummary, tokens: number) {
  return {
    ...answered,
    environmentId: EnvironmentId.make("laptop"),
    label: "Laptop",
    summary: {
      ...summary,
      sources: summary.sources.map((source) => ({
        ...source,
        fingerprint: { ...source.fingerprint, hostId: "laptop" },
      })),
      buckets: summary.buckets.map((bucket) => ({
        ...bucket,
        totals: { ...bucket.totals, uncachedInputTokens: tokens },
      })),
    },
  };
}

it("shows Laptop's 200 on web until it answers after Desk loses access during a rolling refresh", async () => {
  const { answered, summary } = setup();
  const tick = makeWindow(1, new Date("2026-11-21T18:56:00Z"), "hour");
  const next = makeWindow(1, new Date("2026-11-21T18:57:00Z"), "hour");
  const laptop = laptopAnswer(answered, summary, 200);
  state.environments = [answered, laptop];
  await using screen = await render(<ScopedUsage window={tick} />);
  await expect.element(screen.getByText("300 tokens")).toBeVisible();

  state.environments = [
    { ...answered, summary: null, isPending: true },
    { ...laptop, summary: null, isPending: true },
  ];
  await screen.rerender(<ScopedUsage window={next} />);
  await expect.element(screen.getByText("300 tokens")).toBeVisible();
  state.environments = [
    { ...answered, canReadDiagnostics: false, summary: null, error: "Access revoked" },
    { ...laptop, summary: null, isPending: true },
  ];
  await screen.rerender(<ScopedUsage window={next} />);
  await expect.element(screen.getByText("200 tokens")).toBeVisible();
  await expect.element(screen.getByText("300 tokens")).not.toBeInTheDocument();

  state.environments = [state.environments[0]!, laptopAnswer(answered, summary, 250)];
  await screen.rerender(<ScopedUsage window={next} />);
  await expect.element(screen.getByText("250 tokens")).toBeVisible();
});

it("returns the same web usage state when rerendered with unchanged statuses", async () => {
  const { window, answered } = setup();
  const seen: ReturnType<typeof useUsage>["usage"][] = [];
  function Capture() {
    const usage = useUsage(window);
    seen.push(usage.usage);
    return <UsageProbeResult usage={usage} />;
  }
  await using screen = await render(<Capture />);
  await expect.element(screen.getByText("100 tokens")).toBeVisible();
  state.environments = [{ ...answered }];
  await screen.rerender(<Capture />);
  await screen.rerender(<Capture />);
  expect(seen.length).toBeLessThan(10);
  expect(seen.at(-1)).toBe(seen.at(-2));
  expect(seen.at(-1)).toBe(seen.at(-3));
});

it("reports only the new period's failures on web while retaining the previous figures", async () => {
  const { answered } = setup();
  const date = new Date("2026-11-21T18:56:00Z");
  const week = makeWindow(7, date);
  const month = makeWindow(30, date);
  const desk = { ...answered, label: "Desk", summary: null, error: "Weekly scan failed" };
  const laptop = { ...answered, environmentId: EnvironmentId.make("laptop"), label: "Laptop" };
  state.environments = [desk, laptop];
  await using screen = await render(<ScopedUsage window={week} />);
  await expect.element(screen.getByText(/Weekly scan failed/)).toBeVisible();
  const pending = [desk, laptop].map((env) => ({
    ...env,
    summary: null,
    error: null,
    isPending: true,
  }));
  state.environments = pending;
  await screen.rerender(<ScopedUsage window={month} />);
  await expect.element(screen.getByText("100 tokens")).toBeVisible();
  await expect.element(screen.getByText(/Weekly scan failed/)).not.toBeInTheDocument();
  state.environments = [
    { ...pending[0]!, isPending: false, error: "Monthly scan failed" },
    pending[1]!,
  ];
  await screen.rerender(<ScopedUsage window={month} />);
  await expect.element(screen.getByText(/Monthly scan failed/)).toBeVisible();
  state.environments = pending;
  await screen.rerender(<ScopedUsage window={month} />);
  await expect.element(screen.getByText(/Monthly scan failed/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  await screen.rerender(<ScopedUsage window={month} selection={new Set([desk.environmentId])} />);
  await expect.element(screen.getByText(/Monthly scan failed/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});

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

it("shows only the selected environment's figures when switching environments", async () => {
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
  await expect.element(screen.getByText("Loading usage")).toBeVisible();
  await expect.element(screen.getByText("100 tokens")).not.toBeInTheDocument();

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
