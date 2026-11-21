import {
  AuthDiagnosticsReadScope,
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
  usageNotices,
} from "@t3tools/client-runtime/state/usage-progress";
import {
  cursorKeychainAccessEnvironments,
  usageRefreshingEnvironmentIdsAtom,
} from "@t3tools/client-runtime/state/usage";
import { UsageShareBar } from "../components/usage/UsageShareBar";
import { UsageGapsNotice } from "../components/usage/UsageGapsNotice";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { expect, it, vi } from "vite-plus/test";
import { AtomRegistry } from "effect/reactivity";

import { render } from "../../test/render";
import { useUsage, type EnvironmentUsageStatus } from "./usage";
import { serverEnvironment } from "./server";

const state = vi.hoisted(() => ({
  cursorKeychain: false,
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
          keychain: state.cursorKeychain ? "available" : "unavailable",
          readsCursorAccount: false,
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
  state.cursorKeychain = false;
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
      usage.selectedEnvironments,
      usage.shown?.environments ?? [],
      usage.failures,
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

function ScopedUsage({ window }: { readonly window: UsageSummaryInput }) {
  const usage = useUsage(window);
  const { coverage } = usageNotices(
    usage.selectedEnvironments,
    usage.shown?.environments ?? [],
    usage.failures,
  );
  return (
    <>
      {usage.shown?.hasAnswer ? <p>{usage.shown.merged.totalTokens} tokens</p> : null}
      <UsageGapsNotice notice={coverage} retrying={false} onRetry={() => void usage.refresh()} />
    </>
  );
}

it("keeps Laptop's figures on web after Desk loses access", async () => {
  const { window, answered, summary } = setup();
  const laptop = {
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
        totals: { ...bucket.totals, uncachedInputTokens: 200 },
      })),
    },
  };
  state.environments = [answered, laptop];
  await using screen = await render(<ScopedUsage window={window} />);
  await expect.element(screen.getByText("300 tokens")).toBeVisible();
  state.environments = [
    { ...answered, canReadDiagnostics: false, summary: null, error: "Access revoked" },
    { ...laptop, summary: null, isPending: true },
  ];
  await screen.rerender(<ScopedUsage window={window} />);
  await expect.element(screen.getByText("200 tokens")).toBeVisible();
  await expect.element(screen.getByText("300 tokens")).not.toBeInTheDocument();
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
});

it("offers Keychain access on a cold web Limits visit without requesting a usage summary", async () => {
  const { window } = setup();
  state.cursorKeychain = true;
  const registry = AtomRegistry.make();
  using _cleanup = { [Symbol.dispose]: () => registry.dispose() };
  state.query = (atom) =>
    registry.get(atom as Parameters<typeof registry.get>[0]) as readonly EnvironmentUsageStatus[];
  const summary = vi.mocked(serverEnvironment.usageSummary);
  summary.mockClear();
  function View({ limits }: { readonly limits: boolean }) {
    const usage = useUsage(window, null, [], { enabled: !limits });
    return (
      <div>
        {cursorKeychainAccessEnvironments(usage.selectedEnvironments).map(
          ({ label, environmentId }) => (
            <button key={environmentId} type="button">
              Enable Cursor usage from {label}
            </button>
          ),
        )}
      </div>
    );
  }
  await using screen = await render(<View limits />);
  await expect
    .element(screen.getByRole("button", { name: "Enable Cursor usage from Desk" }))
    .toBeVisible();
  expect(summary).not.toHaveBeenCalled();
  await screen.rerender(<View limits={false} />);
  expect(summary).toHaveBeenCalledOnce();
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
