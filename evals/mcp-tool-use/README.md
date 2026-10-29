# MCP tool use

Replays small fake threads on Claude and Codex models and checks how they use T3's MCP tools: delegation, PR linking, previews, scheduling, and more. Each case reproduces a real mistake an agent made in CodeShip.

The model sees what it sees in CodeShip. A trimmed capture of a real harness turn supplies the harness prompt and native tools. T3's instructions, tool descriptions, and schemas come from this checkout. A cheap model plays the shell, so nothing runs on your machine.

## Run

```sh
cd evals
pnpm mcp-tool-use --case review-round-uses-thread-send --samples 1 --out runs/check
pnpm mcp-tool-use --model claude-opus-5-5 --out runs/opus
```

- With one available provider, the runner selects it automatically. OpenAI uses `OPENAI_API_KEY` or your existing `codex login`; Anthropic uses `ANTHROPIC_API_KEY`.
- With both available, choose `--provider openai` or `--provider anthropic`. Set `CODESHIP_EVAL_PROVIDER=openai` (or `anthropic`) in the repo root's gitignored `.env` to save your default. An explicit `--provider` or `--model` overrides it; an unavailable explicit choice fails without switching providers.
- Both the agent and shell simulator use the selected provider. OpenAI defaults to Luna for both; Anthropic defaults to Sonnet and Haiku. `--model` and `--shell-model` select models within that provider.
- Existing CLIProxyAPI setups can opt in with `--provider openai --proxy`; this uses the `vibeproxy` entry in `~/.codex/config.toml`. The proxy must serve the selected OpenAI agent and simulator models.
- Codex credentials are refreshed by its app-server and held in memory. Model-produced tool calls still run only against the simulated machine.
- Flags: `--case <ids>`, `--cases <file.ndjson>`, `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (samples in flight, default 8), `--max-steps <n>`, `--effort <level>`, `--dry-run` (prints request bodies, no model calls), and `--context` (prints the size of CodeShip's text and schemas, no key needed). Offline runs default to OpenAI; use `--provider anthropic` to inspect Claude cases.
- `--baseline <results.jsonl> --stop-on-regression` stops as soon as a case that passed every baseline sample fails. Use it to test one copy change against a baseline run.
- Cost: a full Sonnet run is about $9, and a full Opus run about $17. OpenAI usage follows your API key or Codex subscription; the report records tokens without estimating its price.

## Add a case

Cases are JSON lines in `cases/`, one file per area. The case schema in `run.ts` (`McpToolUseCase`) documents every field.

- `kind`: `bad` reproduces a mistake, `guard` protects correct behavior, `control` is ordinary work.
- `experience`: the real mistake, in a sentence. `source`: where it happened.
- `setup`: the fake thread, its `world` (repo, branch, files, PRs, pages), `priorTurns`, and `mocks` for tool results.
- `expect`: the checks, such as `calls`, `callsMustNot`, `maxCalls`, `order`, `textMust`, and `linked`.

Check that the case builds with `--dry-run --case <id>`. Then run it on the text before your fix, where it must fail, and on the text after, where it must pass.

## Where T3's text lives

- `packages/provider-core/src/server/runtimeInstructions.ts`
- `packages/provider-core/src/server/orchestrationInstructions.ts`
- `apps/server/src/provider/CodexDeveloperInstructions.ts`
- `apps/server/src/mcp/toolkits/*/tools.ts` (tool descriptions)
- `packages/contracts/src/*Mcp.ts` (parameter descriptions and result text)

## Templates

`templates/` holds one trimmed capture per harness. Refresh them when a harness changes its prompt or native tools:

1. Capture one CodeShip turn through CLIProxyAPI, with T3's MCP server connected.
2. From `evals/`, run `pnpm mcp-tool-use:trim-capture <claude|codex> <capture.json> mcp-tool-use/templates/<claude|codex>.json.gz`. It keeps only what `run.ts` reads, and removes user instructions, the user's own skills and agents, account ids, and home paths.
3. Read the output for user data before you commit it: `zcat <file> | less`.
4. Run the full eval on the old and new templates, and compare.
