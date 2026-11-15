/** Data + messages shared by the extension and the cards webview. No imports: bundled into both. */

export type CliHealth = 'ok' | 'missing' | 'outdated';

export interface CardLimit {
  label: string;
  percent: number;
  resets?: string;
  /** Exact reset time (epoch ms), when the source has one. */
  resetsAt?: number;
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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const HALF_YEAR_MS = 183 * 86_400_000;

/**
 * Reads a reset text — "Nov 12 at 12pm (Asia/Saigon)", "Nov 16, 1:00 AM", "5pm" — as local time
 * (epoch ms). `ref` is when the text was fetched: a time alone means that day, and the year is
 * the one that puts the date closest to it.
 */
export function parseResetText(text: string, ref: number): number | undefined {
  const s = text.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const date = /^([a-z]{3,9})\.?\s+(\d{1,2})\b/i.exec(s);
  const rest = date ? s.slice(date[0].length).replace(/^\s*(?:,|at\b)?\s*/i, '') : s;
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(rest);
  if (rest && (!time || (!time[2] && !time[3]))) return undefined;
  if (!date && !time) return undefined;
  let hours = 0;
  let minutes = 0;
  if (time) {
    hours = Number(time[1]);
    minutes = Number(time[2] ?? 0);
    if (time[3]) {
      if (hours < 1 || hours > 12) return undefined;
      hours = (hours % 12) + (time[3].toLowerCase() === 'pm' ? 12 : 0);
    }
    if (hours > 23 || minutes > 59) return undefined;
  }
  const r = new Date(ref);
  if (!date) return new Date(r.getFullYear(), r.getMonth(), r.getDate(), hours, minutes).getTime();
  const month = MONTHS.indexOf(date[1].slice(0, 3).toLowerCase());
  const day = Number(date[2]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  const at = (year: number) => new Date(year, month, day, hours, minutes).getTime();
  const t = at(r.getFullYear());
  if (t < ref - HALF_YEAR_MS) return at(r.getFullYear() + 1);
  if (t > ref + HALF_YEAR_MS) return at(r.getFullYear() - 1);
  return t;
}

/** When a limit resets (epoch ms): the exact time when known, else read from its text. */
export function resetTime(l: CardLimit, fetchedAt: number): number | undefined {
  if (typeof l.resetsAt === 'number') return l.resetsAt;
  return l.resets ? parseResetText(l.resets, fetchedAt) : undefined;
}

/** When the weekly limit resets (the same limit `rowReset` shows), if known. */
export function weeklyResetAt(limits: CardLimit[], fetchedAt: number): number | undefined {
  for (const l of limits) {
    if (limitKind(l.label) !== 'weekly') continue;
    const t = resetTime(l, fetchedAt);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** Soonest weekly reset first. Items without a known reset keep their order, after the others. */
export function sortByWeeklyReset<T>(items: T[], resetAt: (item: T) => number | undefined): T[] {
  return items
    .map((item, i) => ({ item, i, t: resetAt(item) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t - b.t))
    .map((x) => x.item);
}
