# Plugins

Plugins add skills, commands, agents, hooks, and MCP servers to Claude, Codex, and Grok. Open
**Extensions** in the sidebar rail and choose the **Plugins** tab, or **Open plugins** from the command palette, to browse what their
marketplaces offer and install, turn off, or remove plugins. With more than one account or machine,
pick which one to manage at the top of the page. Claude and Codex accounts on the same machine
share their plugins, unless you gave an account its own config directory.

Cursor, OpenCode, and Antigravity manage their plugins in their own apps and settings, so they are
not listed here.

New sessions load your changes. A thread that is already running keeps the plugins it started with
until its session restarts.

## Add a marketplace

Claude starts with Anthropic's plugin directory, and Codex with OpenAI's catalog and the
marketplaces in its `config.toml`. Choose **Add marketplace** and enter a GitHub repository such as
`owner/repo`, a git or https URL, or a folder path on the machine that runs the provider. Its
plugins then appear under **Available**.

A Codex marketplace, such as a local Dale marketplace, is not a Claude marketplace, so add each
marketplace to the provider it was made for. Grok also reads Claude marketplaces, so one such as
`anthropics/claude-plugins-official` can be added to Grok too. If Grok lists no plugins, add xAI's
marketplace, `xai-org/plugin-marketplace`.

## Things to know

- Some Codex plugins connect to apps such as Gmail or Google Drive. After installing one, connect
  the app from the notice CodeShip shows, or in ChatGPT, before the plugin can use it.
- Plugins marked **Managed** are installed by the provider itself, such as plugins synced from your
  claude.ai account. You can turn them off but not remove them here.
- Removing a Claude or Grok plugin keeps its saved data, so installing it again picks up where it
  left off.
- Grok asks you to trust a plugin before it can run hooks and MCP servers on your machine.
  Installing one here gives that trust.
- Grok turns plugins on and off by name, so the same plugin installed from two marketplaces shares
  one switch.
- A Claude plugin that runs its own setup command installs only from a terminal with
  `claude plugin install`, where you can review the command first.
- Changing plugins needs permission to manage providers on that environment. Without it the page is
  read-only.
