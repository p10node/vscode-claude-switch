/** Data + messages shared by the extension and the cards webview. No imports: bundled into both. */

export type CliHealth = 'ok' | 'missing' | 'outdated';

export interface CardLimit {
  label: string;
  percent: number;
  resets?: string;
}

export interface CardProfile {
  id: string;
  name: string;
  isDefault: boolean;
  active: boolean;
  loggedIn: boolean;
  email?: string;
  plan?: string;
  org?: string;
  busy?: 'auth' | 'usage' | 'login' | 'logout';
  /** Waiting for its turn in the quota queue. */
  queued?: boolean;
  folderMissing: boolean;
  usage?: { limits: CardLimit[]; fetchedAt: number; source: 'cli' | 'cache'; hasRaw: boolean };
  usageError?: string;
  authError?: string;
  configDir: string;
  configDirShort: string;
  key: { label: string; detail: string; present: boolean };
  sharing: { state: 'shared' | 'separate' | 'disabled' | 'source' | 'none'; linked: number; separate: string[] };
}

/** Which reset the account row shows (`claudeSwitch.resetDisplay`). */
export type ResetDisplay = 'weekly' | 'session';

export interface CardsState {
  cli: CliHealth;
  resetDisplay: ResetDisplay;
  profiles: CardProfile[];
}

/** "Current session" → session (the 5-hour window), "Current week (…)" → weekly. */
export function limitKind(label: string): ResetDisplay | undefined {
  if (/\bsession\b/i.test(label)) return 'session';
  if (/\bweek/i.test(label)) return 'weekly';
  return undefined;
}

/** "Nov 12 at 11:59am (Asia/Saigon)", "Nov 12, 12:00 PM", "5pm (Asia/Saigon)" → date and/or time. */
function splitReset(resets: string): { date?: string; time?: string } {
  const s = resets.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const m = /^(.+?)(?:,| at )\s*(.+)$/.exec(s);
  if (m) return { date: m[1].trim(), time: m[2].trim() };
  return /\d\s*[ap]m\b|\d:\d\d/i.test(s) ? { time: s } : { date: s };
}

/**
 * Reset shown at the end of an account row: the weekly limit as a date ("Nov 19"), or the session
 * as a time ("5pm"). An account without any limit of the preferred kind shows the other kind.
 */
export function rowReset(limits: CardLimit[], prefer: ResetDisplay): { text: string; limit: CardLimit } | undefined {
  const preferred = limits.filter((l) => limitKind(l.label) === prefer);
  const limit = (preferred.length ? preferred : limits).find((l) => l.resets);
  if (!limit?.resets) return undefined;
  const { date, time } = splitReset(limit.resets);
  const text = limitKind(limit.label) === 'session' ? (time ?? date) : (date ?? time);
  return text ? { text, limit } : undefined;
}

/** Commands the webview may run (all are `claudeSwitch.<name>`). */
export const CARD_COMMANDS = [
  'addAccount',
  'switch',
  'unlink',
  'checkQuota',
  'showUsageDetails',
  'login',
  'logout',
  'startClaude',
  'openTerminal',
  'revealFolder',
  'revealCredentials',
  'copyPath',
  'unifyShared',
  'rename',
  'remove',
  'installCli',
] as const;

export type CardCommand = (typeof CARD_COMMANDS)[number];

export type ToWebview = { type: 'state'; state: CardsState };
export type FromWebview = { type: 'ready' } | { type: 'run'; command: CardCommand; profileId?: string };
