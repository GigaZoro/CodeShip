# Provision Codex for one-shot text generation

Build the patched Codex executable for the same operating system and architecture as the
CodeShip server. This is a separate host-provisioned tool.
CodeShip's standard Codex downloads and desktop packages contain stock Codex.

## Build from pinned source

The patch targets OpenAI Codex 0.171.0, commit
`ccf9be8cc458bd6b8336fe84d68d8893f2691a5e`. The source archive's checksum pins its exact
contents. The [Codex 0.171.0 release](https://github.com/openai/codex/releases/tag/rust-v0.171.0)
and the [upstream build guide](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/docs/install.md#build-from-source)
describe the base release and toolchain.

The recipe uses Rust 1.99.1 and the host's C/C++ build tools. On Ubuntu Noble, provide
`build-essential`, `pkg-config`, `libssl-dev`, `libcap-dev` and Python 3. On macOS,
use the Xcode Command Line Tools. Cargo needs access to the pinned Rust dependencies
and the V8 assets for the build target. The Linux build and loopback checks cover this
patch. Build and validate the executable on each other host platform before opting in.

Run from the CodeShip checkout with Git, curl, tar, patch, shasum, and the pinned Rust toolchain:

```sh
set -eu
recipe_dir="$PWD/docs/operations/codex-metadata"
build_dir="$(mktemp -d)"
cd "$build_dir"
curl --fail --location --silent --show-error \
  https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v0.171.0 \
  -o codex.tar.gz
printf '%s  %s\n' \
  fd77744299602d6663fe2ace84fc338b33a23a3b125a691757c31ea8c58e5217 codex.tar.gz \
  72eeb5f795f7e4b3948181d8e54571b1fb15cab80b77258bb54ee050bfc7f7c4 "$recipe_dir/codeship-metadata.patch" \
  7a55f63506d4679fa9685c83e26f8b166ae3c7610d273f913168ee599bec8d9f "$recipe_dir/cargo-lock.diff" \
  | shasum -a 256 -c -
tar -xzf codex.tar.gz
cd codex-rust-v0.171.0
git apply "$recipe_dir/codeship-metadata.patch"
cd codex-rs
patch Cargo.lock < "$recipe_dir/cargo-lock.diff"
cargo +1.99.1 build --locked -p codex-cli --bin codex
env -i "$PWD/target/debug/codex" exec --help
```

The [source patch](./codeship-metadata.patch) supplies the empty personal instruction
snapshot for the new metadata thread. The [lockfile patch](./cargo-lock.diff) reconciles
the archived workspace package versions with the release manifest without changing the
dependency resolutions. The final help command should list `--codeship-metadata`.
It takes no prompt and requires no sign-in.

## Opt in on the server host

Keep the executable in a directory controlled by the host operator, outside project
checkouts and provider installation directories. Set `T3CODE_CODEX_METADATA_BINARY_PATH`
in the environment that launches the CodeShip server to the executable's absolute path,
then restart CodeShip. Use an absolute local drive path to an `.exe` for a native Windows server.
The setting is host-wide and applies to one-shot text generation for Codex instances
using either Codex's own login or CodeShip-managed sign-in.

For an instance with a custom **Binary path**, the explicitly configured launcher must
match the host metadata path. A compatible POSIX launcher must dispatch to the patched
binary by absolute path, pass `exec --help` with an empty environment, support
`mcp list --json`, and forward the one-shot arguments and final stdout. Set the host
opt-in only if this routing suits any `codex` wrapper selected through the default
`PATH` lookup for interactive sessions.

CodeShip uses the selected account's home and launch configuration for one-shot
requests. The mode omits the Codex home's personal `AGENTS.md` from automatic
instruction loading. Codex still loads repository instructions and checks its
effective requirements. A conflicting policy, unusable executable, or failed MCP
inventory fails the request. Interactive sessions and sign-in use their normal launcher.

Unset `T3CODE_CODEX_METADATA_BINARY_PATH` and restart CodeShip to restore the standard
one-shot runner. It uses the normal provider executable and reads the structured reply
from Codex's `--output-last-message` temp file. Stock Codex loads personal instructions
as usual and rejects `--codeship-metadata` if you pass it directly.
