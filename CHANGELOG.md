# Changelog

## Unreleased

- Background quota scan: every logged-in account is re-checked every 5 minutes (`claudeSwitch.quotaAutoRefreshMinutes`), active account first. `claudeSwitch.quotaAutoRefresh` turns it off.
- All quota checks go through one queue: one `/usage` at a time with a pause in between (`claudeSwitch.quotaCheckSpacingSeconds`, default 10 s) to stay clear of rate limits. A manual check jumps ahead. Queued accounts show a clock icon.
- Quota checked in one window shows up in the others; the newer result always wins.

## 0.1.0

- Accounts panel with two views: a list with filter and inline details (default) or a tree.
- After a switch, open Claude Code chats are reopened on the new account (window reload; waits while a chat is working).
- Add accounts with the official `claude auth login`; switch, unlink, log out, rename, remove, import a folder.
- Quota per account via `/usage` and Claude Code's own usage cache.
- Status bar item on the right with every limit, e.g. `Default 95%, 100%`.
- Sessions, memory, history, settings, skills and plugins shared across accounts through links to `~/.claude`.
- `CLAUDE_CONFIG_DIR` applied to integrated terminals, the Claude Code extension and optional shell env files.
- Detects a missing or outdated Claude Code CLI and guides the install or update.
- Release workflow: pushing a version tag creates the GitHub Release and publishes to the VS Code Marketplace and Open VSX.
