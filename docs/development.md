# Development

Requires [Bun](https://bun.sh) 1.2+. VS Code runs the extension in its own Node.js; Bun is only used to install, bundle and test.

## Commands

```sh
bun install
bun run build     # bundle → out/extension.js (Node) + out/cards.js (webview)
bun run watch     # rebuild on save
bun run check     # type-check extension, webview, tests
bun test          # unit tests (test/*.test.ts)
bun run package   # clean + check + test + minified build + .vsix
```

## Debugging

Press F5, or use Run and Debug:

| Launch config             | Uses                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Run Extension`           | Your real settings, `~/.claude-switch` and Claude Code extension                                     |
| `Run Extension (sandbox)` | Separate settings, extensions and profiles folder in `.vscode-test/`; your real setup is not touched |

In both configs the **Default** account is your real `~/.claude`.

Typical loop:

1. Run `bun run watch`.
2. Press F5.
3. Edit code.
4. Run **Developer: Reload Window** in the Extension Development Host.

To test the missing-CLI flow, set `claudeSwitch.claudePath` to a path that does not exist.

## Layout

```text
src/
  extension.ts    controller: commands, refresh, login watcher
  claude.ts       official CLI calls + parsing (no vscode import)
  links.ts        shared-data symlinks, unify, seed
  store.ts        account registry (profiles.json)
  activation.ts   CLAUDE_CONFIG_DIR → terminals / Claude Code extension / env files
  terminal.ts     terminals pinned to one account
  tree.ts         tree view
  cardsView.ts    webview provider for the cards view
  model.ts        types shared with the webview
  webview/cards.ts  cards UI (browser)
media/cards.css   cards styles (VS Code theme variables only)
scripts/build.ts  Bun bundler + codicon copy
test/             bun:test unit tests
```

## Installing a build

Run **Extensions: Install from VSIX…** from the Command Palette and choose `claude-account-switch-<version>.vsix`. This works in VS Code and in VS Code forks.

## Releasing

Publishing runs in GitHub Actions ([.github/workflows/publish.yml](../.github/workflows/publish.yml)) when a version tag is pushed. Only `git` is needed.

1. Bump `version` in `package.json` and add a `## <version>` section to `CHANGELOG.md`. Commit.
2. Tag and push:

   ```sh
   git tag v0.1.1
   git push origin main v0.1.1
   ```

The workflow checks that the tag matches `package.json`, type-checks, tests and builds. It then creates the GitHub Release (notes taken from that `CHANGELOG.md` section) with the `.vsix` attached, and publishes the same `.vsix` to both stores.

One-time setup:

| Store               | Setup                                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code Marketplace | [Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), no token: publisher `p10node` → **Trusted Publishing** → owner `p10node`, repository `vscode-claude-switch`, workflow `publish.yml`, no environment |
| Open VSX            | First release: repository secret `OVSX_PAT` (open-vsx.org → Settings → Access Tokens). Afterwards, as namespace owner: register Trusted Publishing on open-vsx.org → Settings → Trusted Publishers (same values) and delete the secret                    |

Azure DevOps personal access tokens for the Marketplace stop working on December 1, 2026, so the workflow does not use one.

To publish by hand: upload the `.vsix` from `bun run package` on the [Marketplace management page](https://marketplace.visualstudio.com/manage), and run `OVSX_PAT=… bun run publish:ovsx` for Open VSX.
