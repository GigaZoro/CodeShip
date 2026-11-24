# Codex for one-shot text generation

Fork releases bundle a private Codex 0.172.0 for metadata requests. The macOS arm64 and Windows x64 desktop apps carry it in `Resources/codex-metadata` (lowercase `resources` on Windows). The Linux x64 server archive carries it beside `t3`. Windows desktop embeds that same Linux archive for WSL. Remote web and mobile clients use the package on their connected server. Interactive sessions and sign-in continue to use the configured provider.

## Release recipe

The [native build](../../../.github/workflows/release-codex-metadata.yml) uses OpenAI Codex commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6` from the [0.172.0 release](https://github.com/openai/codex/releases/tag/rust-v0.172.0). It verifies the source archive against SHA-256 `8a4a4bd174f87394ed7a63c8fe1bf8207d9d691468e465fe56e418018ecc5549`. The [source patch](./codeship-metadata.patch) adds `exec --codeship-metadata-no-mcp`, which starts fresh metadata threads without personal instructions or MCP servers. Child threads inherit the same restrictions. Repository instructions and effective policy still apply.

The [lockfile patch](./cargo-lock.diff) sets 174 local package versions to 0.172.0, including five implicit Cargo workspace members. Its SHA-256 is `45523edd17c7d09b394043592f50ef10c6be1bfa59348c7e663d30f130ac07ed`. The resulting `codex-rs/Cargo.lock` has SHA-256 `0c017d96dae581ea09834ddbda7c572dd48e771cf86e9f87f8b3bcb4ab16f686`. Cargo builds only the CLI with Rust 1.99.1 and `--locked`.

[Package staging](./package.mjs) verifies the published SHA-512 of the matching OpenAI npm platform package before extracting its CLI manifest, code-mode host, ripgrep and platform sandbox helpers. Linux builds use the upstream musl toolchain and embed the digest of the exact bundled bubblewrap binary. Windows ships the command runner and sandbox setup executable. The official code-mode host already contains its matching V8 runtime. The package omits voice assets, the stock CLI and build intermediates.

A cache miss runs the native build and a loopback repository-read test on a standard hosted runner. The key includes the target, runner, workflow, staging recipe and both patches. The macOS build and any retry use the workflow from the published release tag. Releases reuse the completed package across CodeShip versions. The Windows packaging job runs on Linux, so the cache contains a tarball that preserves the native file layout and modes. Each release requires the exact cache entry before staging, and the ordinary installer contains the package. The adjacent `codex-metadata.files` inventory identifies installations that require it. WSL uses the verified archive to repair a missing or incomplete package.

## Verify an installed package

From a CodeShip source checkout, pass the installed package directory to the verifier, then the full path of its CLI to the smoke test. For an extracted Linux archive:

```sh
node docs/operations/codex-metadata/package.mjs verify "$install_dir/codex-metadata" x86_64-unknown-linux-musl
python3 docs/operations/codex-metadata/smoke.py "$install_dir/codex-metadata/bin/codex"
```

For macOS use target `aarch64-apple-darwin` and the app's resources directory. On native Windows use `x86_64-pc-windows-msvc` and `bin/codex.exe`. The smoke test creates a temporary Codex home, repository and unauthenticated loopback model. It checks that the Code Mode host reads a fresh repository value with the bundled ripgrep under the read-only policy. Both the parent and its child must omit personal instructions and keep configured MCP servers stopped. Linux repository commands require permission to create the sandbox namespaces. Ubuntu hosts with restricted unprivileged user namespaces can deny the bundled helper with `bwrap: loopback: Failed RTM_NEWADDR`. The host’s existing Codex sandbox policy applies.

## Source checkouts

A source server or unbundled development app has no installed metadata package. For development with this mode, provision the complete host-specific directory from the native build and point `T3CODE_CODEX_METADATA_BINARY_PATH` at its absolute `bin/codex` (or `bin/codex.exe`) before starting the server. Keep it outside agent-controlled project directories. The native binary uses the selected account's Codex configuration. See the [Codex provider guide](../../user/providers-codex.md) for launcher selection.
