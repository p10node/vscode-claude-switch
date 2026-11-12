# Configuration

## Settings

| Setting                                 | Default            | Description                                                                          |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `claudeSwitch.viewStyle`                | `cards`            | `cards` or `tree`                                                                    |
| `claudeSwitch.claudePath`               | `""`               | Path to `claude`; empty = auto-detect                                                |
| `claudeSwitch.profilesRoot`             | `~/.claude-switch` | Registry, account folders and shell env files                                        |
| `claudeSwitch.applyToTerminals`         | `true`             | Set `CLAUDE_CONFIG_DIR` in new integrated terminals                                  |
| `claudeSwitch.syncClaudeCodeExtension`  | `true`             | Write `CLAUDE_CONFIG_DIR` into `claudeCode.environmentVariables`                     |
| `claudeSwitch.reloadAfterSwitch`        | `auto`             | Reload so open Claude Code chats reopen on the new account: `auto`, `ask` or `never` |
| `claudeSwitch.writeShellEnvFiles`       | `true`             | Write `env.sh`, `env.fish`, `env.ps1` and `active`                                   |
| `claudeSwitch.shareData`                | `true`             | Symlink sessions, memory, settings… from `~/.claude`                                 |
| `claudeSwitch.shareExclude`             | caches, telemetry  | Entries of `~/.claude` that are not shared                                           |
| `claudeSwitch.seedGlobalConfig`         | `true`             | Copy non-login preferences into new accounts once                                    |
| `claudeSwitch.quotaAutoRefresh`         | `true`             | Re-check every account's quota in the background, one at a time                      |
| `claudeSwitch.quotaAutoRefreshMinutes`  | `5`                | Minutes between two background scans                                                 |
| `claudeSwitch.quotaCheckSpacingSeconds` | `10`               | Pause between two `/usage` runs (queue)                                              |
| `claudeSwitch.showStatusBar`            | `true`             | Show the active account and its usage in the status bar                              |

## Views

- **List** (default, `cards`): a filter box and one two-line row per account (email, quota, reset date). Click a row or press Enter to show its usage bars, folder, key and a row of action icons. ↑ ↓ move between rows; Esc clears the filter.
- **Tree**: a native tree; expand an account to see its details. Actions are in the inline buttons and the right-click menu.

To change the view, use **Show as Tree** or **Show as Cards** (the list) in the panel's `…` menu, or set `claudeSwitch.viewStyle`.

## Shell integration

Terminals outside VS Code can follow the active account too. Run **Claude Switch: Set Up Shell Integration…**, pick your shell, and paste the copied line into its config file:

| Shell      | File                         | Line                                                                                  |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| zsh / bash | `~/.zshrc` / `~/.bashrc`     | `[ -f "$HOME/.claude-switch/env.sh" ] && . "$HOME/.claude-switch/env.sh"`             |
| fish       | `~/.config/fish/config.fish` | `test -f "$HOME/.claude-switch/env.fish"; and source "$HOME/.claude-switch/env.fish"` |
| PowerShell | `$PROFILE`                   | `if (Test-Path '<root>\env.ps1') { . '<root>\env.ps1' }`                              |

Terminals opened from a card set `CLAUDE_SWITCH_PINNED=1`, so the env files leave them on their own account.

## Commands

All commands are under **Claude Switch:** in the Command Palette. When run from there, the ones that need an account ask you to pick one.

| Command                                 | What it does                                       |
| --------------------------------------- | -------------------------------------------------- |
| Add Account…                            | Log in a new account, or import an existing folder |
| Switch to This Account                  | Make the account active                            |
| Unlink (Back to Default ~/.claude)      | Use the default `~/.claude` again                  |
| Check Quota / Check Quota of All…       | Run `/usage`                                       |
| Log In… / Log Out…                      | `claude auth login` / `claude auth logout`         |
| Start Claude in Terminal                | `claude` as that account                           |
| Open Terminal as This Account           | A shell as that account                            |
| Unify Sessions & Memory with ~/.claude… | Merge separate entries into `~/.claude`            |
| Install / Update Claude Code CLI…       | Guided install or update                           |
