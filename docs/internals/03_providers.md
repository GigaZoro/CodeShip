# Providers

Provider protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../packages/provider-core/src/server/ProviderAdapter.ts). Orchestration and
clients read declared capabilities, never provider names.

## Identity and integration shape

- **App IDs are primary; provider IDs are refs.** Never match native provider IDs globally without
  provider/session/thread scope, and never let child provider turn completions close a parent run.
- **Route by provider instance, not driver kind.** Session state, catalogs, and credentials belong
  to a provider instance so two accounts on the same driver cannot share mutable state. Strip
  ambient credentials the instance did not configure.
- **Strict ACP compliance for non-first-party agents.** Generic
  [ACP Registry](../user/providers-acp.md) and local ACP commands follow the ACP specification
  strictly—never deviate from the spec or add agent-id checks, vendor extensions, or
  driver-specific workarounds in the shared ACP adapter for non-first-party agents. If an upstream
  ACP agent deviates from or lacks part of the spec, let orchestration degrade through capabilities
  rather than special-casing it here. Dedicated ACP flavors (over `packages/provider-acp`) are
  reserved for first-party drivers that need behavior outside the ACP spec; native
  `ProviderAdapterV2` adapters are only for non-ACP protocols.
- **Package boundaries.** Providers live in `packages/provider-<name>` (see
  [Pi](../../packages/provider-pi) as reference). Server code imports only
  `@t3tools/provider-core/server/*`, contracts, and shared, reaching host capabilities through
  `ProviderHost` rather than `apps/server`. Client definitions (`./client`) must stay browser- and
  React Native-safe.

## Choose the integration shape

The generic ACP integration excludes per-agent branches, private vendor RPC or HTTP calls, and
readers for a vendor CLI's credentials or history. A dedicated driver requires a maintainer's
explicit decision to own that integration. Existing exceptions establish no precedent.

Decline workarounds for agents that violate the ACP spec and ask the author to file an issue with
the agent's maintainer, including a minimal protocol transcript and the relevant spec section.
Missing portable capabilities belong upstream in ACP. Vendor-neutral primitives, including shared
ACP text generation and user-hosted HTTP quota sources, are welcome.

A misleading permission guarantee in T3 is a T3 bug. Correct the shared behavior so the capability
and permission claims match what the protocol can enforce.

## Honest capabilities and permissions

- **Declare only what the provider actually supports.** Turn off fork, rollback, steering, or
  subagent capabilities the provider lacks so orchestration degrades cleanly (for example, portable
  context handoff for forks). A capability left enabled that fails at runtime is a bug.
- **Never emulate missing permission modes.** Expose only modes the provider enforces natively; do
  not fake a mode by auto-answering approvals in T3. Unoffered stored modes fall back to Supervised.
  Pass native approval and question option IDs through unchanged, and ensure every request can be
  declined.
- **Hide plan mode unless it produces proposed-plan cards.**
- **Startup phases come from real signals.** An adapter reports the step a starting turn is on as
  `startupPhase` on its provider session, and only when the protocol says so: a notification or an
  awaited request with one meaning, never a timer. Clear it the moment the provider can be doing
  something else. Clients show it until the run's first output. A session that serves several
  threads names the one it describes with `startupPhaseThreadId`.
  Nothing an adapter emits during `openSession` is visible, because the session is not attached yet.
  Turn start republishes `runtime.providerSession`, so a phase that spans it must be on that record.
- **Reject conversation rollback before touching files** when the provider cannot roll back its
  conversation (see [checkpoints](./01_architecture.md#turn-completion-and-checkpoints)).

## Process, setup, and security boundaries

- **Health checks must stay passive.** Background status and model probes must never open a session
  that starts MCP servers, runs hooks, or launches a login flow. Reserve heavier probes for explicit
  refresh or setup.
- **Updates run only through a provably owning installer.** Prove ownership from the resolved
  executable path (or use a self-updater that checks its own install); leave ambiguous, pinned, or
  read-only installs (such as Nix) manual-only.
- **Attachments stay outside the project workspace.** Never copy uploads into the project tree to
  bypass a provider's sandbox or approval rules.
- **T3 MCP tools.** Inject the thread's authenticated MCP server so agents can reach T3 tools, and
  keep turns working if that server is unreachable.

## Model manifest

The bundled [`model-manifest.json`](../../apps/server/src/provider/model-manifest.json) enables
offline startup while remote fetches from `main` update metadata between releases. A bundled
manifest outranks the cached remote copy by `updatedAt`, so **bump `updatedAt` on every edit**.
Declare broken-version minimums in the manifest policy rather than as driver constants. Test catalog
and adapter semantics with synthetic model names so adding a model never requires duplicating config
in tests.

## Cross-provider traps and testing

Prove adapter behavior with replay fixtures recorded from the real provider and replayed through the
real orchestrator, adapter, and projections. Hand-written protocol frames guess at wire behavior; use
unit tests for pure logic and failure paths a real provider cannot trigger on demand.

Traps that have broken multiple adapters:

- **Lazy config advertisement.** Providers often advertise options only after a session opens or a
  model runs. Wait for advertisement before applying settings, and skip unoffered stored options
  rather than failing.
- **`"Default"` is a sentinel, not a model ID.** Never send it to a provider; clear or reset the
  session's model selection instead.
- **Early Stop.** Cancelling before the provider registers the prompt can be ignored or strand a
  session. Gate cancellation on the provider's turn-started signal.
- **Work outliving a turn.** Background tasks, subagents, and provider-initiated continuations can
  report after T3's turn settles. Route subagent updates by subagent (not active run), request
  continuations when needed, and report pending background work so idle cleanup does not kill the
  session.
- **Terminal settlement.** Every terminal path (completion, Stop, provider error, process exit) must
  settle open tool calls, subagents, and pending requests.
- **Usage limits.** Classify quota/rate-limit errors as `usage_limit` (with reset time when
  available) rather than generic failures.
- **Symlinked workspaces.** Test symlinked paths (such as macOS `/tmp`); providers that compare
  canonical paths break if cwd handling disagrees.

## Auto funding

Declare `included` only when the executable account or model can use its
allowance without falling through to paid usage. Leave funding unknown when a login, model
name or quota reading does not establish this. If the destination can select a different payer,
set `auth.fundingScope` to `workspace` and implement `fundingForWorkspace` on the instance.
Auto calls it with the actual launch directory and model before choosing the account.
ACP agents can declare funding for each model
through `_meta["t3.codes/funding"]` on its model entry or model-select choice. That declaration
must hold across the workspaces where the instance advertises it.

## Process and account isolation

Accounts of one provider share MCP server configuration but never MCP sign-ins. OAuth servers
rotate refresh tokens, so a sign-in copied into a second credential store is retired when either
copy refreshes, and the other account is signed out. Codex also keeps these sign-ins in the OS
keychain, shared across every `CODEX_HOME` without a shared refresh lock, so an added Codex
account launches with the file store and keeps `.credentials.json` in its own shadow home. The main
Codex account does not get the flag: it shares `~/.codex` with other Codex apps, and Codex's default
store mode deletes the file entry whenever it saves that server's sign-in to the keychain.

All processes of one account do share its sign-ins, and a renewal must never present a refresh token
another process already used: ThreadPage then revokes the sign-in. Codex serializes renewals across
processes on one `CODEX_HOME`. Claude Code renews only in a token's last five minutes, under a lock
file in its config folder, but a process that waits for that lock longer than about ten seconds, or
gets a 401, renews without it. So an added Claude account's folder never links Claude's lock files
(a linked lock dangles once released, and Claude then never takes it), and
[the Claude driver](../../apps/server/src/provider/Drivers/ClaudeMcpSignInRenewal.ts) has Claude
renew each MCP sign-in four minutes before it expires, while the old token still works. A sign-in
that expired anyway (after sleep or a long restart) is renewed once before any new Claude process of
the account starts, and every process starting meanwhile waits for that renewal.

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories and global MCP config (`config/mcp_config.json`) under that
profile, so the profile links those back to the user's real `~/.gemini`, giving every account the
user's skills and MCP servers as Claude and Codex accounts get theirs. Hooks and rules there stay
out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

## Provider updates run only through the owning installer

A package manager runs only when the resolved executable's path proves it owns the install. Homebrew
and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global directories of pnpm, Bun, Yarn, and Vite+ may match on
either the resolved path or its real target, since those installers place real files or their own
symlinks there. Volta is proven by the package's image directory plus either its `volta-shim` link
or, on Windows, the exact cmd or bash forwarding script Volta generates; a custom script that merely
calls `volta run` does not qualify. When nothing is proven, Pi's and Grok's own updaters
(`pi update --self`, `grok update`) run instead, because each detects its installer itself; the
runner's version check catches an updater that exits 0 without updating. Claude, Codex, and OpenCode updaters only act on their own native layout, so
those providers stay manual-only unless that layout is proven. Mise is checked
first, since a `mise x` wrapper can sit at a native installer's path, and `MISE_DATA_DIR` can put
installs anywhere, so `mise which` is asked whenever mise is on `PATH`. Each driver names its fixed
mise tool; mise must resolve the binary and list it in an active install of that tool requested as
`latest`, which gets `mise upgrade <tool>`. T3.CodeShip keeps launching the configured path, so that
path must be a shim or under the tool's `latest` link, which the upgrade repoints: a version
directory (including one `mise activate` put on `PATH`) would keep running the old binary until mise
prunes it. Everything else mise touches (fixed version paths, pinned tools, wrappers, OpenCode 1.x,
whose mise tool crosses into 2.x) stays manual-only, so T3.CodeShip never edits mise config. Nix store installs stay manual-only too, since the store is read-only. `mise latest` supplies the version, because settings such as
`minimum_release_age` can hold mise behind npm. A Grok cask whose Homebrew prefix
cannot be verified also stays manual-only: `grok update` would install a second copy. npm updates pin `--prefix` because the
`npm` on `PATH` can belong to a different Node than the one that owns the provider. Homebrew
compares against `brew info` since casks trail npm by hours. Claude's native installs compare
against the release channel `claude update` follows (`autoUpdatesChannel` in Claude's settings,
read from downloads.claude.ai), because `stable` trails npm's `latest` by about a week and the
updater exits 0 without moving past it; other native installs compare against the npm registry.
A Chocolatey install of Claude stays
manual-only: its package directory is writable only by administrators, and `claude update` through
the shim installs a native copy elsewhere. The latest version comes from `choco search`, and the
card shows `choco upgrade claude-code` without running it.
See the [resolver](../../apps/server/src/provider/providerMaintenanceRunner.ts).
