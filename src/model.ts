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

export interface CardsState {
  cli: CliHealth;
  profiles: CardProfile[];
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
