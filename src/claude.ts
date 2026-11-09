/**
 * Everything that talks to Claude Code goes through its own CLI:
 *   claude auth login | logout | status --json      (official subcommands)
 *   claude -p /usage                                  (official slash command)
 * plus reading non-secret metadata Claude Code keeps in <config>/.claude.json.
 * This module never reads, copies or sends OAuth tokens.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Profile } from './store';
import { expandHome, readJsonFile, str } from './util';

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  /** Set when `claude auth status` could not be run / parsed. */
  error?: string;
}

export interface UsageLimit {
  label: string;
  percent: number;
  resets?: string;
}

export interface UsageInfo {
  fetchedAt: number;
  limits: UsageLimit[];
  /** Plain text printed by `/usage` (only for source 'cli'). */
  raw?: string;
  /** 'cli' = we ran /usage, 'cache' = read from Claude Code's own cache in .claude.json. */
  source: 'cli' | 'cache';
  accountUuid?: string;
}

export interface AccountMeta {
  email?: string;
  displayName?: string;
  orgName?: string;
  plan?: string;
  accountUuid?: string;
  cachedUsage?: UsageInfo;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** <config>/.claude.json — for the default setup it lives in the home folder. */
export function globalConfigFile(p: Profile): string {
  return p.isDefault ? path.join(os.homedir(), '.claude.json') : path.join(p.configDir, '.claude.json');
}

export function credentialsFile(p: Profile): string {
  return path.join(p.configDir, '.credentials.json');
}

/** macOS Keychain service name Claude Code uses for this config dir (same formula as Claude Code). */
export function keychainService(p: Profile): string {
  if (p.isDefault) return 'Claude Code-credentials';
  const hash = createHash('sha256').update(p.configDir.normalize('NFC')).digest('hex').substring(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Environment for running Claude Code as this account. */
export function profileEnv(p: Profile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_SWITCH_PINNED: '1', NO_COLOR: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete env.CLAUDECODE;
  if (!p.isDefault) env.CLAUDE_CONFIG_DIR = p.configDir;
  return env;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the `claude` binary. Returns undefined when it is not installed.
 * `configured` = claudeSwitch.claudePath (a path, or a bare command name looked up in PATH).
 * `extraCandidates` = e.g. the binary bundled with the official Claude Code extension.
 */
export function resolveClaudeBinary(configured: string, extraCandidates: string[] = []): string | undefined {
  const c = expandHome(configured.trim());
  if (c && /[\\/]/.test(c)) return isExecutableFile(c) ? c : undefined;
  const win = process.platform === 'win32';
  const base = c || 'claude';
  const names = win ? [`${base}.exe`, `${base}.cmd`, base] : [base];
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    path.join(home, '.claude', 'local'),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    ...(win && process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
  ];
  for (const d of dirs) {
    for (const n of names) {
      const candidate = path.join(d, n);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return c ? undefined : extraCandidates.find(isExecutableFile);
}

/** Official install commands (https://code.claude.com/docs/en/setup). */
export const INSTALL_DOCS_URL = 'https://code.claude.com/docs/en/setup';
export function installCommands(platform = process.platform): { label: string; detail: string; command: string }[] {
  const native =
    platform === 'win32'
      ? { label: 'Native installer (recommended)', detail: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' }
      : { label: 'Native installer (recommended)', detail: 'curl … | bash', command: 'curl -fsSL https://claude.ai/install.sh | bash' };
  return [
    native,
    ...(platform === 'darwin' ? [{ label: 'Homebrew', detail: 'brew', command: 'brew install --cask claude-code' }] : []),
    { label: 'npm', detail: 'Node.js 18+', command: 'npm install -g @anthropic-ai/claude-code' },
  ];
}

/** `claude auth …` exists only in recent Claude Code versions. */
export function looksOutdated(a?: AuthStatus): boolean {
  return !!a?.error && /unknown (command|option)|did you mean|invalid command/i.test(a.error);
}

export function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child = execFile(
      bin,
      args,
      { env, timeout: timeoutMs, cwd: os.tmpdir(), windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        let code = 0;
        let extra = '';
        if (e) {
          code = typeof e.code === 'number' ? e.code : -1;
          if (typeof e.code !== 'number') extra = e.killed ? `timed out after ${timeoutMs / 1000}s` : e.message;
        }
        resolve({ code, stdout: String(stdout ?? ''), stderr: [String(stderr ?? ''), extra].filter(Boolean).join('\n') });
      },
    );
    // `claude -p` reads piped stdin until EOF — close it so it never waits.
    child.stdin?.end();
  });
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** First JSON object in a string (tolerates warnings printed before it). */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function parseAuthStatus(stdout: string): AuthStatus | undefined {
  const j = extractJson(stdout);
  if (!j || typeof j.loggedIn !== 'boolean') return undefined;
  return {
    loggedIn: j.loggedIn,
    authMethod: str(j.authMethod),
    email: str(j.email),
    orgName: str(j.orgName),
    subscriptionType: str(j.subscriptionType),
  };
}

/** Parse lines like "Current week (all models): 95% used · resets Nov 12 at 12pm (Asia/Saigon)". */
export function parseUsageText(text: string): UsageLimit[] {
  const out: UsageLimit[] = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?([^:]{1,80}?):\s*(\d+(?:\.\d+)?)\s*%\s*used\b(.*)$/i.exec(line);
    if (!m) continue;
    const rest = m[3].replace(/^[\s·•|,;-]+/, '').trim();
    const resets = rest.replace(/^resets?\s*/i, '').trim();
    out.push({ label: m[1].trim(), percent: Math.round(Number(m[2])), resets: resets || undefined });
  }
  return out;
}

function formatReset(iso: unknown): string | undefined {
  if (typeof iso !== 'string') return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function limitLabel(l: Record<string, unknown>): string {
  const kind = String(l.kind ?? '');
  const group = String(l.group ?? '');
  const scope = l.scope as { model?: { display_name?: unknown } } | null | undefined;
  const scopeName = str(scope?.model?.display_name);
  if (group === 'session' || kind.startsWith('session') || kind === 'five_hour') return 'Current session';
  if (group === 'weekly' || kind.startsWith('weekly') || kind.startsWith('seven_day')) {
    return `Current week (${scopeName ?? (kind === 'weekly_all' || kind === 'seven_day' ? 'all models' : kind.replace(/_/g, ' '))})`;
  }
  const base = kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) || 'Limit';
  return scopeName ? `${base} (${scopeName})` : base;
}

/** Claude Code caches the last /usage result in .claude.json → `cachedUsageUtilization`. Parsed defensively. */
export function parseCachedUsage(u: unknown, accountUuid?: string): UsageInfo | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const c = u as Record<string, unknown>;
  const fetchedAt = Number(c.fetchedAtMs);
  if (!fetchedAt) return undefined;
  const owner = str(c.accountUuid);
  if (accountUuid && owner && owner !== accountUuid) return undefined;
  const ut = (c.utilization ?? {}) as Record<string, unknown>;
  const limits: UsageLimit[] = [];
  if (Array.isArray(ut.limits)) {
    for (const l of ut.limits as Record<string, unknown>[]) {
      if (!l || typeof l.percent !== 'number') continue;
      limits.push({ label: limitLabel(l), percent: Math.round(l.percent), resets: formatReset(l.resets_at) });
    }
  } else {
    const legacy: [string, string][] = [
      ['five_hour', 'Current session'],
      ['seven_day', 'Current week (all models)'],
      ['seven_day_opus', 'Current week (Opus)'],
      ['seven_day_sonnet', 'Current week (Sonnet)'],
    ];
    for (const [key, label] of legacy) {
      const v = ut[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
      if (v && typeof v.utilization === 'number') {
        limits.push({ label, percent: Math.round(v.utilization), resets: formatReset(v.resets_at) });
      }
    }
  }
  return { fetchedAt, limits, source: 'cache', accountUuid: owner };
}

/** Non-secret account info from <config>/.claude.json (`oauthAccount` never contains tokens). */
export function readAccountMeta(p: Profile): AccountMeta | undefined {
  const j = readJsonFile<Record<string, unknown>>(globalConfigFile(p));
  if (!j) return undefined;
  const o = (j.oauthAccount ?? {}) as Record<string, unknown>;
  const meta: AccountMeta = {
    email: str(o.emailAddress),
    displayName: str(o.displayName),
    orgName: str(o.organizationName),
    plan: str(o.planDisplayName),
    accountUuid: str(o.accountUuid),
  };
  meta.cachedUsage = parseCachedUsage(j.cachedUsageUtilization, meta.accountUuid);
  return meta;
}

export async function getAuthStatus(bin: string, p: Profile): Promise<AuthStatus> {
  const r = await run(bin, ['auth', 'status', '--json'], profileEnv(p), 30_000);
  const parsed = parseAuthStatus(r.stdout);
  if (parsed) return parsed;
  const msg = stripAnsi(r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit code ${r.code}`;
  return { loggedIn: false, error: msg.slice(0, 300) };
}

/** Runs `/usage` exactly like typing it in Claude Code. */
export async function fetchUsage(bin: string, p: Profile): Promise<UsageInfo> {
  const started = Date.now();
  const r = await run(bin, ['-p', '/usage'], profileEnv(p), 120_000);
  const raw = stripAnsi([r.stdout, r.stderr].filter(Boolean).join('\n')).trim();
  const limits = parseUsageText(raw);
  if (!limits.length) {
    // Output format changed? Claude Code refreshes its own cache while running /usage.
    const cached = readAccountMeta(p)?.cachedUsage;
    if (cached && cached.fetchedAt >= started - 5_000 && cached.limits.length) return { ...cached, raw };
    if (r.code !== 0) throw new Error(raw.split(/\r?\n/)[0] || `claude exited with code ${r.code}`);
  }
  return { fetchedAt: Date.now(), limits, raw, source: 'cli' };
}

export function logout(bin: string, p: Profile): Promise<ExecResult> {
  return run(bin, ['auth', 'logout'], profileEnv(p), 30_000);
}

/** Checks whether the Keychain item exists. Reads attributes only — never the secret, so no prompt. */
export function keychainHasItem(service: string): Promise<boolean | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = execFile('/usr/bin/security', ['find-generic-password', '-s', service], { timeout: 5_000 }, (err) =>
      resolve(!err),
    );
    child.stdin?.end();
  });
}

/** Every limit in display order, e.g. "95%, 100%" (weekly all models, weekly Fable). */
export function percentsText(u?: UsageInfo): string | undefined {
  if (!u?.limits.length) return undefined;
  return u.limits.map((l) => `${l.percent}%`).join(', ');
}

export function peakPercent(u?: UsageInfo): number | undefined {
  if (!u?.limits.length) return undefined;
  return Math.max(...u.limits.map((l) => l.percent));
}
