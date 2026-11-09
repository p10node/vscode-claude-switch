import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Profile } from './store';

/**
 * Terminal pinned to one account, whatever account is active.
 * The terminal-wide EnvironmentVariableCollection is applied *after* a terminal's own `env`,
 * so the variable is set by a wrapper (`/usr/bin/env` / PowerShell) instead.
 */
export function createAccountTerminal(
  p: Profile,
  opts: { name: string; command?: { bin: string; args: string[] }; icon?: string },
): vscode.Terminal {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const iconPath = new vscode.ThemeIcon(opts.icon ?? (opts.command ? 'sparkle' : 'terminal'));

  if (process.platform === 'win32') {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const setEnv = p.isDefault
      ? `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue;`
      : `$env:CLAUDE_CONFIG_DIR=${q(p.configDir)};`;
    const prelude = `$env:CLAUDE_SWITCH_PINNED='1'; ${setEnv}`;
    const script = opts.command
      ? `${prelude} & ${q(opts.command.bin)} ${opts.command.args.map(q).join(' ')}`
      : prelude;
    return vscode.window.createTerminal({
      name: opts.name,
      cwd,
      iconPath,
      shellPath: 'powershell.exe',
      shellArgs: opts.command ? ['-NoLogo', '-Command', script] : ['-NoLogo', '-NoExit', '-Command', script],
    });
  }

  const envArgs = p.isDefault
    ? ['-u', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SWITCH_PINNED=1']
    : ['CLAUDE_SWITCH_PINNED=1', `CLAUDE_CONFIG_DIR=${p.configDir}`];
  let target: string[];
  if (opts.command) {
    target = [opts.command.bin, ...opts.command.args];
  } else {
    const shell = vscode.env.shell || process.env.SHELL || '/bin/sh';
    const login = ['bash', 'zsh', 'fish', 'sh', 'ksh', 'dash'].includes(path.basename(shell));
    target = login ? [shell, '-l'] : [shell];
  }
  return vscode.window.createTerminal({
    name: opts.name,
    cwd,
    iconPath,
    shellPath: '/usr/bin/env',
    shellArgs: [...envArgs, ...target],
  });
}
