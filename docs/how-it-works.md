# How it works

## Accounts are config folders

Claude Code stores its config and login in one folder: `~/.claude` by default, or whatever `CLAUDE_CONFIG_DIR` points to. This extension gives each account its own folder:

```text
~/.claude                          ← "Default" account, and the shared data
~/.claude-switch/
  profiles.json                    ← account list + active account
  profiles/work/                   ← CLAUDE_CONFIG_DIR of "Work"
    .claude.json                   ← this account only (login info)
    projects      → ~/.claude/projects       (sessions + memory)
    history.jsonl → ~/.claude/history.jsonl
    settings.json → ~/.claude/settings.json
    skills, plugins, agents, commands, CLAUDE.md, todos, … → ~/.claude/…
  env.sh / env.fish / env.ps1 / active    ← optional shell integration
```

## Switching and unlinking

**Switching** (linking) an account points `CLAUDE_CONFIG_DIR` at its folder:

| Target                                 | How                                                |
| -------------------------------------- | -------------------------------------------------- |
| New integrated terminals               | VS Code `EnvironmentVariableCollection`            |
| New chats of the Claude Code extension | `claudeCode.environmentVariables` in user settings |
| Shells outside VS Code (opt-in)        | `source ~/.claude-switch/env.sh`                   |

**Unlinking** removes the variable, so everything uses the default `~/.claude` again.

New Claude Code chats pick up the new account right away. Chats that are already open run in a process that started with the previous account, so after a switch the extension reloads the window (setting `claudeSwitch.reloadAfterSwitch`, default `auto`):

- No Claude Code chat open: nothing to do.
- Chats open and idle: the window reloads, and Claude Code reopens every tab with the same session, now on the new account. This works because sessions are shared between accounts.
- A chat still working: you choose **Reload Now** (the reply in progress stops; ask the chat to continue after it reopens) or **Reload When Idle** (the window reloads once every chat has been quiet for a few seconds).

When the switch happens in another window, this window follows the same rules and always waits for its chats to finish. Whether a chat is working comes from the status Claude Code records for each chat (`sessions/<pid>.json`); for older versions without it, the extension guesses from the CPU time of the chat and its tools. On Windows it asks instead.

`claude` processes running in terminals keep their account until you restart them.

Terminals started from a card with **Start Claude** or **Terminal** stay on that card's account, whichever account is active.

## What is shared and what is per account

Setting `CLAUDE_CONFIG_DIR` alone would give each account a separate copy of everything. To prevent that, every entry of `~/.claude` is symlinked into each account folder, except:

- `.claude.json`: account info and per-account caches. When an account is created, non-login preferences are copied into it once: onboarding state, theme, trusted projects and MCP servers.
- The key (see below).
- `backups`, and the entries listed in `claudeSwitch.shareExclude` (telemetry, caches, …).

Links are only ever added where nothing exists. If an entry already exists separately in an account folder, the card shows it as **Separate**. **Unify** fixes this:

1. Moves the entry to `.claude-switch-backup/<time>/` inside the account folder.
2. Copies its content into `~/.claude` without overwriting anything. `.jsonl` files are appended; for other files, the `~/.claude` version wins.
3. Replaces the entry with a link.

## Keys

Claude Code stores the login itself:

| Platform      | Location                                                                              |
| ------------- | ------------------------------------------------------------------------------------- |
| macOS         | Keychain item `Claude Code-credentials` (default) or `Claude Code-credentials-<hash>` |
| Linux/Windows | `<config folder>/.credentials.json`                                                   |

`<hash>` is the first 8 hex characters of the SHA-256 of the exact `CLAUDE_CONFIG_DIR` path. The extension shows where the key is. On macOS it only checks whether the Keychain item exists, which reads attributes and never the secret.

## Quota

There are two sources:

- **Check quota** runs `claude -p /usage` as that account and reads the lines shown by Claude Code (`Current week (all models): 95% used · resets …`).
- The usage cache that Claude Code keeps in `.claude.json` while you work. It is read on refresh and when the window gets focus, with no extra request.

Every `/usage` run goes through one queue: accounts are checked one at a time with a pause in between (`claudeSwitch.quotaCheckSpacingSeconds`), so several accounts never hit the API at once. A manual **Check Quota** jumps ahead of the queue.

By default a background scan re-checks every logged-in account every 5 minutes (`claudeSwitch.quotaAutoRefreshMinutes`); the account in use goes first. Only the focused window scans, and an account checked less than half an interval ago (for example by another window) is skipped. Turn it off with `claudeSwitch.quotaAutoRefresh`.

## Why this approach

- It relies only on the official CLI (`claude auth login | logout | status`, `/usage`) and the documented `CLAUDE_CONFIG_DIR` variable.
- It never reads, copies, stores or sends OAuth tokens or API keys.
- It makes no network requests of its own.
- Every account signs in through the normal login flow.

Use it for accounts you legitimately own. Follow Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and [Usage Policy](https://www.anthropic.com/legal/aup).

## Finding the Claude Code CLI

The CLI is searched for in this order:

1. `claudeSwitch.claudePath`
2. `PATH`
3. `~/.local/bin`, `~/.claude/local`, Homebrew, npm, bun
4. The binary bundled with the official Claude Code extension

If none is found, a notification and a banner in the panel offer to install it: native installer, Homebrew or npm. The command is typed into a terminal for you to review; nothing runs until you press Enter. Once installed, the CLI is detected when the terminal closes or when the window gets focus. A CLI that is too old to have `claude auth` gets a `claude update` offer instead.

## Limitations

- Don't move or rename an account folder. Its Keychain item name depends on the exact path, so a moved folder looks logged out.
- MCP servers added later with `claude mcp add --scope user` live in each account's `.claude.json`. Prefer project `.mcp.json` or plugins.
- If Claude Code rewrites a shared file by replacing it, the file becomes **Separate**. Run **Unify** again.
- On Windows, linking files may need Developer Mode. Folders use junctions and work without it.
- A `CLAUDE_CONFIG_DIR` exported globally in your shell config overrides the extension in terminals.
