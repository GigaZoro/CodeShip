# Dev container

`.devcontainer/` provides a Linux development environment matching CI, with `vp`, Rust, and the GitHub CLI installed and workspace dependencies prepared before you attach. Open the repo in VS Code ("Reopen in Container") or create a GitHub Codespace.

## What works

- `vp run dev` (open the printed pairing URL through the forwarded web port; in browser Codespaces, pass the forwarded origin via `T3CODE_DEV_ALLOWED_ORIGINS` if rejected).
- Linux CI checks: focused `vp test run <files>`, `vp lint <files>`, package typechecks, `vp run build:desktop`, and the resource-monitor Cargo build and tests.

## State and caching

`T3CODE_HOME` points at the workspace's gitignored `.t3`. Named Docker volumes hold the pnpm store and root `node_modules` so container rebuilds stay fast and off slow host bind mounts. The host sees an empty `node_modules`; run tooling inside the container.

## Out of scope

- Windowed Electron development and mobile native builds (Xcode / Android SDK) are host-only; headless desktop bundles and static checks run in the container.
- `vp run dev --share` requires Tailscale, which is not provisioned here.

## Prebuilds

Codespaces prebuilds bake in `onCreateCommand` and `updateContentCommand` automatically. Note that prebuild snapshots exclude named caching volumes, so a prebuild-first workflow may prefer dropping the volume mounts. Outside Codespaces, push a prebuilt image with:

```bash
devcontainer build --workspace-folder . --push true --image-name <registry>/t3code-devcontainer:latest
```

## Agents and plugins

`.devcontainer/install-agents.sh` installs the Claude Code and Codex CLIs, plus the frontend-design Claude plugin and the Dale Codex plugin, so T3.CodeShip in a codespace can run both providers and its Plugins page works. Sign in once per container with `claude` (then `/login`) and `codex login --device-auth`. Plugins synced from your claude.ai account appear after sign-in. The script is idempotent; a failure during creation only warns, so rerun it if the container was created offline.

Dale's repository is a plugin rather than a marketplace, so the script wraps it in a local `dale-local` marketplace under `~/.local/share/dale-marketplace`, matching the plugin id a Mac install uses.
