#!/usr/bin/env bash
# Installs the Claude Code and Codex CLIs and the plugins this fork's
# maintainers use, so T3.CodeShip in a codespace has providers to run and
# plugins to show. Idempotent: rerun it after an offline container creation.
set -euo pipefail

npm install -g @anthropic-ai/claude-code @openai/codex

# Plugins synced from a claude.ai account arrive after sign-in; this one is
# installed per machine.
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install frontend-design@claude-plugins-official --scope user

# The Dale repo is a plugin, not a marketplace, so wrap it in a local one
# named like the maintainer's Mac marketplace to keep the plugin id the same.
dale_marketplace="$HOME/.local/share/dale-marketplace"
if [ -d "$dale_marketplace/plugins/dale/.git" ]; then
  git -C "$dale_marketplace/plugins/dale" pull --ff-only --quiet
else
  git clone --quiet --depth 1 https://github.com/lubluniky/dale.git "$dale_marketplace/plugins/dale"
fi
mkdir -p "$dale_marketplace/.agents/plugins"
cat >"$dale_marketplace/.agents/plugins/marketplace.json" <<'EOF'
{
  "name": "dale-local",
  "interface": { "displayName": "Dale" },
  "plugins": [
    {
      "name": "dale",
      "source": { "source": "local", "path": "./plugins/dale" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
      "category": "Productivity"
    }
  ]
}
EOF
codex plugin marketplace add "$dale_marketplace"
codex plugin add dale@dale-local
