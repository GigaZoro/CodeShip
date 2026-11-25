# Testing

Rules for writing tests, and for asking for them in review. AGENTS.md carries the same writing rules under Verifying; change both together.

## What to test

- Test behavior that can break, such as orchestration and event-sourcing, provider protocol translation, auth and permission guards, persistence and migrations, external-format parsing, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in web and mobile copies of the same logic.
- In review, ask for a missing test only when it would catch a real regression. Do not ask for one assertion per constant, label, or `switch` case. Flag a new test that breaks the rules above, and name the fix: fold it into the existing case or table, delete it, or keep one layer.
- Backend behavior changes ship with focused tests for that behavior.
- Tests run on Windows too. Gate a test that needs `sh` or another POSIX tool with `describe.skipIf(isWindowsHost)` or `it.skipIf(isWindowsHost)` (from `@t3tools/shared/testing/hostPlatform`), so Windows reports it as skipped, and a Windows-only test with `runIf`. Never return early on the platform inside the test: it reports a pass that never ran.
- Tests make temp folders under `os.tmpdir()`. One that must stay in the checkout, such as a relative PATH entry on cwd's drive, goes in a gitignored folder: `vp run check:changed` fails a run whose files changed while it ran. `t3code/no-checkout-temp-dir-in-tests` enforces this.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in an existing case of the module's test file where one fits), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.

## Waiting for work

- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for a subprocess, browser, or other process the test waits on. Servers and sockets inside the test process work under `it.effect`; under `it.live`, every timeout in the code under test races the machine's load. A test of a timeout stalls only the call it times out, until the test releases it, and leaves the calls that share the bound a wide margin.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - `drain()` runs only what the outbox holds when it looks. Automatic starts held for memory (restart, network and usage-limit continuations) get their start effects later, one at a time, from the admission queue's own fiber, so drain until the outcome the test asserts instead of counting rounds.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`, `t3code/no-platform-early-return-in-tests`.

## Web browser tests

- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `t3code/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

## Traps

- **Shared database.** Tests inside one `it.layer(layerTest)` block (`runtimeLayer.test.ts`, `FoundationPersistence.test.ts`) share a database, and `worker.runOnce()` claims the oldest effect from any thread. A test that leaves outbox rows pending breaks later ones: run the handler directly and settle or delete only your own rows by `effect_id` or `thread_id`.
- **Replayed command ids.** Under `TestClock` two `recovery.reconcile("startup")` calls reuse one command id (it embeds the timestamp), so the second commits nothing. `TestClock.adjust` between restarts.
- **Waiting on the reactor.** The orchestrator's run-update reactor is one ordered stream. Start a queued run in a second thread after your event and await its `starting` event.
- **Seed through the production write path** (`OrchestrationEventStore.appendAgentEvents` with real `OrchestrationV2DomainEvent`s), never raw INSERTs into a table you picked: a query and a test seeded into the retired `orchestration_v2_events` agree on a result that is always 0 in production (`t3code/no-retired-event-table`).
- **Settle state.** `thread.unsettled` is not one per reopen: the unsettle command sets `settledOverride: "active"`, the next turn emits a second one, and pinning a settled chat reopens it with `thread.pinned` alone. Every `thread.*` event except `thread.pull-request-link-updated` carries the whole thread, so count settled→not-settled transitions with `LAG`. A test history must mix cases that do not cancel each other.
- **Scheduler registration run.** `Scheduler.register` forks a run that does due work when the registering fiber next yields, so unrelated startup statements can move it past a test's setup. Provide `Layer.succeed(ServerActivation, Effect.never)` to park it and fork subscribers with `Effect.forkScoped({ startImmediately: true })`. Do not make the Scheduler skip that run: eight other test files rely on it.
- **A silent focused run.** A `vp test run` of one server file that prints nothing for 20 minutes is every test hitting the 120 s timeout, usually from a mock that yields a non-Effect (`yield* undefined`, `Effect.andThen(() => value)`). Run `vp run typecheck` first and pass `--reporter=verbose`.
- **Proving a test fails without its fix.** `git checkout -- <file>` is blocked by a hook, so copy the fixed file to the scratchpad, change only the fix's condition, run the one test, copy it back and grep that the fix is there, each as its own call. A test that waits on an event hangs without the fix and can leave it reverted when the call is killed; say it hangs instead of running it. macOS has no `timeout`.
- **Tool text.** Editing an MCP tool's description or schema trips two tests outside the file: `AgentContextBudget.test.ts` compares measured bytes with `agentContextBudget.json` exactly, and `toolTextArguments.test.ts` flags a code span like `` `key=...` `` as an argument the tool lacks. Run both before landing.
- **Codex's macOS sandbox** refuses `fs.watch` on a folder (EMFILE) and makes `os.uptime()` throw EPERM, so the `CommandRunner` tests that stop a tree hang under it. Run them unsandboxed or report "could not run".
- **A cached check runs Oils, not bash.** On macOS, Vite+'s file tracker runs its bundled Oils `osh` for every `bash` and `sh` that a cached `check:changed` group starts, by path or through `PATH`. `osh` reports itself as bash 5.3 and refuses bash's own flags such as `--noprofile`, while a lone `vp test run` gets the real shell and passes. A test that needs the machine's real shell goes in `uncachedTests` in `scripts/check-changed.ts`.
- **No test cache on Windows.** There the file tracker crashes every MSYS program a cached group starts (`sh.exe: *** fatal error - MapViewOfFileEx 'shared.5' ... Win32 error 487`), which includes Git for Windows' `sh` and `bash`. Git pushes to a local remote through `sh`, so such a push fails with `fatal: Could not read from remote repository`. `cachedTestTasks` in `scripts/lib/cached-tests.ts` therefore runs every group uncached on Windows, for `check:changed` and `test:cached` alike, and a rerun repeats every group. The test timeout there is 180 s, not 60 s (`vite.config.ts`), because a `check-changed.test.ts` fixture that runs whole checks takes up to 85 s.
- **Windows-only cases** from a Mac: delegate to a Claude child on a Windows machine (a Codex child's sandbox denies WMI, so process-tree tests fail). Clone with `git -c core.autocrlf=false`, and read logs with `FileShare.ReadWrite`.
- **Background checks.** `vp run check:changed > log 2>&1; echo "exit $?"` makes the task notice report the `echo`'s status. Let the check's own exit code be the task's, and read the log's `FAIL` lines.
