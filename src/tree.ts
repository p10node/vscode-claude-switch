import * as vscode from 'vscode';
import { AccountMeta, AuthStatus, credentialsFile, percentsText, UsageInfo } from './claude';
import { LinkReport } from './links';
import { CliHealth } from './model';
import { Profile, ProfileStore } from './store';
import { pathExists, relativeTime, tildify } from './util';

export interface ProfileState {
  auth?: AuthStatus;
  meta?: AccountMeta;
  usage?: UsageInfo;
  usageError?: string;
  busy?: 'auth' | 'usage' | 'login' | 'logout';
  /** Waiting in the quota queue (one `/usage` runs at a time). */
  queued?: boolean;
  links?: LinkReport;
  keychain?: { service: string; exists?: boolean };
  folderMissing?: boolean;
}

export interface ProfileNode {
  kind: 'profile';
  profile: Profile;
}

export interface DetailNode {
  kind: 'detail';
  profileId: string;
  item: vscode.TreeItem;
}

export interface NoticeNode {
  kind: 'notice';
  item: vscode.TreeItem;
}

export type TreeNode = ProfileNode | DetailNode | NoticeNode;

export type { CliHealth };

export interface TreeHost {
  readonly store: ProfileStore;
  stateOf(id: string): ProfileState;
  shareEnabled(): boolean;
  cliHealth(): CliHealth;
}

/** Where Claude Code keeps this account's key (we only point at it, never read it). */
export function keyLocation(p: Profile, st: ProfileState): { label: string; detail: string; present: boolean; keychain: boolean } {
  const credFile = credentialsFile(p);
  const fileExists = pathExists(credFile);
  if (process.platform === 'darwin' && st.keychain && (st.keychain.exists || !fileExists)) {
    return {
      label: `Keychain · ${st.keychain.service}`,
      detail: `macOS Keychain, service “${st.keychain.service}”. Managed by Claude Code itself — this extension never reads it.`,
      present: !!st.keychain.exists,
      keychain: true,
    };
  }
  return {
    label: tildify(credFile),
    detail: `${credFile}\nWritten by Claude Code itself — this extension never reads it.`,
    present: fileExists,
    keychain: false,
  };
}

export function isLoggedIn(st: ProfileState): boolean {
  return st.auth && !st.auth.error ? st.auth.loggedIn : !!st.meta?.email;
}

export function emailOf(st: ProfileState): string | undefined {
  return st.auth?.email ?? st.meta?.email;
}

export function planOf(st: ProfileState): string | undefined {
  if (st.meta?.plan && (st.auth?.loggedIn ?? true)) return st.meta.plan;
  const sub = st.auth?.subscriptionType;
  if (sub) return sub.charAt(0).toUpperCase() + sub.slice(1);
  if (st.auth?.authMethod && st.auth.authMethod !== 'claude.ai' && st.auth.authMethod !== 'none') return st.auth.authMethod;
  return st.meta?.plan;
}

const bar = (pct: number): string => {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▰'.repeat(n) + '▱'.repeat(10 - n);
};

const levelColor = (pct: number): vscode.ThemeColor =>
  new vscode.ThemeColor(pct >= 90 ? 'charts.red' : pct >= 70 ? 'charts.yellow' : 'charts.green');

export function profileTooltip(p: Profile, st: ProfileState, active: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escape(p.name)}**${active ? ' — $(pass-filled) active' : ''}\n\n`);
  const email = emailOf(st);
  if (email) md.appendMarkdown(`$(mail) ${escape(email)}${planOf(st) ? ` · ${escape(planOf(st)!)}` : ''}\n\n`);
  else md.appendMarkdown(`$(circle-slash) not logged in\n\n`);
  const org = st.auth?.orgName ?? st.meta?.orgName;
  if (org) md.appendMarkdown(`$(organization) ${escape(org)}\n\n`);
  md.appendMarkdown(`$(folder) \`${tildify(p.configDir)}\`${p.isDefault ? ' (CLAUDE_CONFIG_DIR unset)' : ''}\n\n`);
  if (st.usage?.limits.length) {
    md.appendMarkdown(`$(dashboard) Quota — ${relativeTime(st.usage.fetchedAt)}\n\n`);
    for (const l of st.usage.limits) {
      md.appendMarkdown(`- ${escape(l.label)}: **${l.percent}%**${l.resets ? ` · resets ${escape(l.resets)}` : ''}\n`);
    }
  }
  return md;
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
}

export class AccountsTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: TreeHost) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(el?: TreeNode): TreeNode[] {
    if (!el) {
      const notice = this.notice();
      const profiles: TreeNode[] = this.host.store.all().map((profile) => ({ kind: 'profile', profile }));
      return notice ? [notice, ...profiles] : profiles;
    }
    if (el.kind === 'profile') return this.details(el.profile);
    return [];
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    return el.kind === 'profile' ? this.profileItem(el.profile) : el.item;
  }

  private notice(): NoticeNode | undefined {
    const health = this.host.cliHealth();
    if (health === 'ok') return undefined;
    const missing = health === 'missing';
    const item = new vscode.TreeItem(missing ? 'Claude Code CLI not found' : 'Claude Code CLI is outdated');
    item.id = 'notice:cli';
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    item.description = missing ? 'click to install' : 'click to update';
    item.tooltip = missing
      ? 'Logging in and checking quota need the official `claude` CLI. Click to install it, or set claudeSwitch.claudePath.'
      : 'This Claude Code version has no `claude auth` command. Click to update it.';
    item.contextValue = 'notice.cli';
    item.command = { command: 'claudeSwitch.installCli', title: 'Install Claude Code CLI' };
    return { kind: 'notice', item };
  }

  private profileItem(p: Profile): vscode.TreeItem {
    const st = this.host.stateOf(p.id);
    const active = this.host.store.active.id === p.id;
    const loggedIn = isLoggedIn(st);
    const item = new vscode.TreeItem(
      p.name,
      active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `profile:${p.id}`;

    const parts: string[] = [];
    const email = emailOf(st);
    if (email) parts.push(email);
    else if (!loggedIn) parts.push('not logged in');
    const plan = planOf(st);
    if (plan) parts.push(plan);
    const pct = percentsText(st.usage);
    if (pct) parts.push(pct);
    item.description = parts.join(' · ');

    if (st.busy) item.iconPath = new vscode.ThemeIcon('loading~spin');
    else if (st.queued) item.iconPath = new vscode.ThemeIcon('clock');
    else if (st.folderMissing) item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    else if (active) item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    else if (!loggedIn) item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    else item.iconPath = new vscode.ThemeIcon('account');

    item.tooltip = profileTooltip(p, st, active);
    item.contextValue = [
      'profile',
      active ? 'active' : 'inactive',
      p.isDefault ? 'default' : 'custom',
      loggedIn ? 'loggedin' : 'loggedout',
      st.usage?.raw ? 'hasusage' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return item;
  }

  private details(p: Profile): DetailNode[] {
    const st = this.host.stateOf(p.id);
    const out: DetailNode[] = [];
    const arg = { kind: 'detail', profileId: p.id };
    const add = (
      key: string,
      label: string,
      icon: vscode.ThemeIcon,
      description?: string,
      opts: { contextValue?: string; tooltip?: string | vscode.MarkdownString; command?: string } = {},
    ) => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = `${p.id}:${key}`;
      item.iconPath = icon;
      item.description = description;
      item.contextValue = opts.contextValue;
      item.tooltip = opts.tooltip ?? (description ? `${label}: ${description}` : label);
      if (opts.command) item.command = { command: opts.command, title: label, arguments: [arg] };
      out.push({ kind: 'detail', profileId: p.id, item });
    };

    if (st.folderMissing) {
      add('missing', 'Config folder is missing', new vscode.ThemeIcon('warning'), tildify(p.configDir));
    }

    // account
    const loggedIn = isLoggedIn(st);
    const email = emailOf(st);
    if (st.busy === 'login') {
      add('account', 'Waiting for login in terminal…', new vscode.ThemeIcon('loading~spin'));
    } else if (loggedIn) {
      const org = st.auth?.orgName ?? st.meta?.orgName;
      add('account', email ?? 'Logged in', new vscode.ThemeIcon('mail'), [planOf(st), org].filter(Boolean).join(' · '), {
        contextValue: 'detail.account',
      });
    } else {
      add('account', 'Not logged in', new vscode.ThemeIcon('sign-in'), st.auth?.error ? st.auth.error : 'click to log in', {
        contextValue: 'detail.account.loggedout',
        command: 'claudeSwitch.login',
      });
    }

    // quota
    if (st.busy === 'usage') {
      add('quota-busy', 'Checking quota (/usage)…', new vscode.ThemeIcon('loading~spin'));
    } else if (st.queued) {
      add('quota-queued', 'Quota check queued', new vscode.ThemeIcon('clock'), 'one /usage at a time');
    }
    if (st.usage?.limits.length) {
      for (const [i, l] of st.usage.limits.entries()) {
        add(`quota-${i}`, l.label, new vscode.ThemeIcon('circle-filled', levelColor(l.percent)), `${bar(l.percent)} ${l.percent}%${l.resets ? ` · resets ${l.resets}` : ''}`, {
          contextValue: 'detail.quota',
          tooltip: `${l.label}: ${l.percent}% used${l.resets ? `, resets ${l.resets}` : ''}`,
        });
      }
      add('quota-age', 'Quota updated', new vscode.ThemeIcon('history'), `${relativeTime(st.usage.fetchedAt)}${st.usage.source === 'cache' ? ' (Claude Code cache)' : ''}`, {
        contextValue: 'detail.quota',
      });
    } else if (st.usage) {
      add('quota-none', 'No subscription quota reported', new vscode.ThemeIcon('info'), relativeTime(st.usage.fetchedAt), {
        contextValue: 'detail.quota',
        tooltip: st.usage.raw?.split(/\r?\n/).slice(0, 8).join('\n'),
      });
    } else if (loggedIn && st.busy !== 'usage' && !st.queued) {
      add('quota-check', 'Check quota', new vscode.ThemeIcon('dashboard'), 'runs /usage', { command: 'claudeSwitch.checkQuota' });
    }
    if (st.usageError) {
      add('quota-error', 'Quota check failed', new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')), st.usageError, {
        contextValue: 'detail.quota',
      });
    }

    // folder + key
    add('folder', 'Config folder', new vscode.ThemeIcon('folder'), tildify(p.configDir), {
      contextValue: 'detail.folder',
      command: 'claudeSwitch.revealFolder',
      tooltip: `${p.configDir}\n${p.isDefault ? 'Default Claude Code folder (CLAUDE_CONFIG_DIR unset)' : `CLAUDE_CONFIG_DIR=${p.configDir}`}`,
    });
    const key = keyLocation(p, st);
    add('key', 'Key', new vscode.ThemeIcon('key'), `${key.label}${key.present ? '' : key.keychain ? ' (empty)' : ' (none)'}`, {
      contextValue: 'detail.key',
      command: 'claudeSwitch.revealCredentials',
      tooltip: key.detail,
    });

    // shared data
    if (!p.isDefault) {
      if (!this.host.shareEnabled()) {
        add('links', 'Sessions & memory', new vscode.ThemeIcon('circle-slash'), 'separate (sharing disabled)');
      } else if (st.links) {
        const { linked, conflicts, errors } = st.links;
        if (conflicts.length || errors.length) {
          add('links', 'Sessions & memory', new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')), `${linked.length} shared · ${conflicts.length} separate`, {
            contextValue: 'detail.links.conflict',
            tooltip: [
              `Shared with ~/.claude: ${linked.join(', ') || '—'}`,
              conflicts.length ? `Separate in this account: ${conflicts.join(', ')} — use “Unify Sessions & Memory” to merge.` : '',
              errors.length ? `Errors: ${errors.join('; ')}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          });
        } else {
          add('links', 'Sessions & memory', new vscode.ThemeIcon('link'), `shared with ~/.claude (${linked.length} items)`, {
            contextValue: 'detail.links',
            tooltip: `Symlinked from ~/.claude: ${linked.join(', ')}`,
          });
        }
      }
    } else if (this.host.shareEnabled() && this.host.store.all().length > 1) {
      add('links', 'Sessions & memory', new vscode.ThemeIcon('database'), 'source shared by all accounts', {
        tooltip: 'Every other account links its sessions, memory, history, settings, skills… to this folder.',
      });
    }
    return out;
  }
}
