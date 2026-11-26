# Observability

Server observability has three outputs: pretty stdout logs (not persisted locally, except SSH-managed launches at `~/.t3/ssh-launch/<state>/server.log`), a local NDJSON trace file (always on), and optional OTLP export (traces, metrics, logs).

## Local traces and event-loop stalls

Default trace paths (`server.trace.ndjson`):

- Production / explicit `--home-dir` / `T3CODE_HOME`: `<home>/userdata/logs/server.trace.ndjson`
- Linked worktree dev run: `<worktree>/.t3/userdata/logs/server.trace.ndjson`
- Non-worktree dev run: `~/.t3/dev/logs/server.trace.ndjson`

Summarize counts, rates, and latency percentiles offline (even while a server is stalled or stopped):

```sh
t3 trace summary --since 30m --limit 40
# Set T3CODE_TRACE_FILE=/path/to/server.trace.ndjson for dev or copied traces
```

Logs emitted inside an active span (`Effect.log*`) attach as span events unless `T3CODE_OTLP_LOGS_URL` is configured (which exports all log records directly to avoid duplicates).

Event-loop stalls (>2 s) write `server.eventLoop.stall` spans and append to `event-loop-stalls.ndjson` beside the trace file. SQLite spans carry `db.connection` (`writer`/`reader`) and `db.lock_wait_ms` (queue wait off the event loop—subtract it before blaming query speed). Metrics live only in-process unless OTLP export is enabled.

At trace level Info or above (the default), with timing enabled, the local server file samples routine spans: SQLite, workflow runs (step code, retry schedules, cleanup and the agent threads a run starts are excluded; spans an author adds in the workflow body itself are sampled), and spans marked with `routineSpan` from `@t3tools/shared/observability` (high-volume lookups and sweeps). A routine span that succeeds in under 10 ms without events is kept only when its own span ID ends in `00` (about one in 256). The key is per span, not per trace or parent, because background fibers share the server's boot trace and recurring ticks reuse one parent span. Counts and averages for these spans in the local file and Settings → Diagnostics are therefore a biased sample. `T3CODE_TRACE_MIN_LEVEL=Debug` keeps everything. This sampling does not apply to OTLP export.

## Local OTLP stack (Grafana LGTM)

```sh
docker run --name lgtm -p 3000:3000 -p 4317:4317 -p 4318:4318 --rm -ti grafana/otel-lgtm
```

Open `http://localhost:3000` (`admin`/`admin`), export OTLP URLs in the shell, and restart the server from that same shell (packaged desktop apps launched from Finder/Dock/Start Menu do not inherit shell env vars):

```sh
export T3CODE_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export T3CODE_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export T3CODE_OTLP_LOGS_URL=http://localhost:4318/v1/logs
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=development
vp run dev
```

## OTLP configuration and kill switches

- **Endpoints:** `T3CODE_OTLP_{TRACES,METRICS,LOGS}_URL` outrank standard `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` and `OTEL_EXPORTER_OTLP_ENDPOINT`. `T3CODE_OTLP_HEADERS` / `T3CODE_OTLP_PROTOCOL` (`http/json` default) apply only to `T3CODE_OTLP_*` endpoints; `OTEL_EXPORTER_OTLP_*` endpoints read `OTEL_EXPORTER_OTLP_*` headers/protocol (`http/protobuf` default). See [user telemetry](../user/telemetry.md#export-diagnostics-to-your-own-receiver) for Settings precedence.
- **Service names are fixed:** `t3code-server` (backend), `t3code-desktop` (Electron main, traces/logs only), and `t3code-web` (UI). `OTEL_SERVICE_NAME` is ignored—distinguish installs with `OTEL_RESOURCE_ATTRIBUTES` (e.g. `deployment.environment.name=staging`).
- **Kill switches:** `T3CODE_OTEL_SDK_DISABLED` (outranks `OTEL_SDK_DISABLED`, accepts standard boolean spellings; `OTEL_SDK_DISABLED` only accepts `true`) disables all OTLP export in server and desktop while keeping local traces and stdout intact. `OTEL_{TRACES,METRICS,LOGS}_EXPORTER=none` disables a single signal unless overridden by `T3CODE_OTLP_*_URL`.
- **Trace tuning:** `T3CODE_TRACE_FILE`, `T3CODE_TRACE_MAX_BYTES`, `T3CODE_TRACE_MAX_FILES`, `T3CODE_TRACE_MIN_LEVEL`, `T3CODE_TRACE_TIMING_ENABLED`.
- **Instrumentation rules:** Trace operation boundaries via `Effect.fn("Service.operation")` (see [Effect services](../internals/02_effect-services.md)). Put high-cardinality IDs/paths on span attributes, never on metric labels.

## Heap snapshots

On macOS and Linux (not Windows), send `SIGUSR2` to the server PID from `server-runtime.json` (in the server's state dir beside `logs/`) to write `<logsDir>/server-<pid>-<timestamp>.heapsnapshot` for Chrome DevTools Memory tab:

```sh
pid="$(jq .pid "${T3CODE_HOME:-$HOME/.t3}/userdata/server-runtime.json")"
ps -p "$pid" -o command=   # verify it is the T3 server—never signal desktop or launcher
kill -USR2 "$pid"
```

- Writing pauses the server (up to a minute+ on large heaps) and needs roughly as much free RAM as the heap—send once, and avoid on a swapping host.
- Snapshots contain tokens, secrets, and thread content. Never share them publicly, and delete them manually when finished.

## Memory admission

Automated heavy starts pass one gate,
[`MemoryAdmission`](../../apps/server/src/resourceTelemetry/MemoryAdmission.ts). These are
scheduled occurrences, `delegate_task` children (including another machine's child) and an
agent's emulator boot. A new automated start path must call it too. Nothing else bounds how
much starts at once across tasks, and the 24 GB Mac panicked with each task within its own
limit. Chats the user starts are never gated.

- macOS judges the compressor's share of physical memory plus the kernel pressure level.
  Compressed memory is not used memory: a normal day reads about 0.31 and must keep
  starting work. The pressure level alone reads normal between warn readings, even at the
  panic, so only the share holds the gate shut.
- A probe that fails or times out admits the start. Linux without `MemAvailable` admits
  too, because free memory leaves out the reclaimable page cache.
- Readings go stale. The scheduler judges again after a run condition answers, and after
  a prompt-file read that waited for the network. That run already shows as running, so a
  shortage there fails it instead of skipping it.

## CPU admission

`t3_command_run` also holds a new command while the CPUs are saturated
([`CpuAdmission`](../../apps/server/src/resourceTelemetry/CpuAdmission.ts)): memory had room
when 18 commands, mostly test suites, started together and left a 12-core machine at 1.00 busy
per core, slow enough to fail the timeouts they were guarded by.

- The reading is the busy share per core over a half-second window of `os.cpus()` times,
  against the 0.95 limit Machine health's `cpu-overload` check uses. A reading stands for two
  seconds so a burst of commands shares it.
- Niced time is room: the scheduler runs a new command ahead of it, so a deliberate low-priority
  load (a flake soak at nice 19) must not hold every command, blockers included. Only niced
  processes at or below a new command's own priority still count. CodeShip starts its agents and
  commands at the server's nice level plus `AGENT_NICE_INCREMENT`, so its own commands are niced
  too; counting all nice time as room would let 18 of them start together again.
  [`HeldNiceTime`](../../apps/server/src/resourceTelemetry/HeldNiceTime.ts) reads each process's
  nice level and CPU time from `/proc` (Linux only) so those stay counted. Without that reading,
  on other platforms or when `/proc` cannot be read, all niced time counts as busy. The queued
  message names the niced share it left out once it reaches 0.10.
- The hold applies only while another `t3_command_run` command of this server is running. With
  none running the first queued command starts whatever the reading: other programs can keep
  the CPUs busy for hours, and a gate that waited for them would starve every command.
- `delegate_task` and the chat-resume queue do not use it. A delegate refuses on memory instead
  of queueing, so a CPU refusal would fail a task that only needs to wait out a burst. The
  resume queue already starts one run at a time, and what a run does on the CPU goes through
  commands.

## Redacting telemetry

Console log lines, every OTLP export (logs, traces and metrics, with the browser traces the server
forwards and the relay's traces) and trace, relay and provider event log file records pass through
one redactor, `packages/shared/src/redaction.ts`, as they are written: credentials and the values of
fields named for one show as `[redacted]`, and e-mail addresses as `[email]`. Logs and spans hold the
raw values in memory, so a new log or trace sink must redact what it writes. The server and the
desktop app install their loggers with `layerRedactedLoggers` from
`packages/shared/src/observability.ts`: loggers print and export a log's message parts apart, so each
one masks the part after one such as `"Cookie"` or `"token:"`, and the console prints redacted text.

## Traces

For a provider sign-in incident, read `provider-auth.trace.ndjson` in the environment's logs
directory, including its `.2` and `.1` backups in oldest-first order. Only server-side
credential operations advance this history. Ordinary trace traffic can rotate out of
`server.trace.ndjson` while the sign-in evidence remains on disk. The current file and two
backups are each limited to 1 MiB.

Use `instanceId`, the start and end timestamps, and the span outcome to reconstruct the
sequence. A successful `ProviderAuthService.start` means the sign-in flow opened. A successful
`providerAuthFlow.persistCredentials` records a completed save. A `ProviderAuthService.stopSessions`
span records the number of released sessions in `releasedSessions`. For counts and durations
in the existing CLI, set `T3CODE_TRACE_FILE` to the provider-auth file and run `t3 trace summary`.
