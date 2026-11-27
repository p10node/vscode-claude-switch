/**
 * Shared data between accounts.
 *
 * CLAUDE_CONFIG_DIR moves *everything* (sessions, memory, history, settings…) to the new folder.
 * To keep one consistent Claude for every account, each account folder only owns its login
 * (.claude.json + key); every other entry is a symlink to the same entry in ~/.claude.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CONFIG_DIR } from './store';
import { pathExists, readJsonFile, writeFileAtomic } from './util';

const BACKUP_DIR = '.claude-switch-backup';

/** Never shared, whatever the settings say: these hold the login of one account. */
export const ALWAYS_SEPARATE = ['.credentials.json', '.claude.json', 'backups', BACKUP_DIR];

/**
 * Locks and temp files (`.oauth_refresh.lock`, `x.lock.owner`, `settings.json.tmp.123`) live only
 * while one process works. A link to one outlives it and keeps the name taken in the account
 * folder: Claude Code can then never take its own lock there, e.g. to refresh the login token.
 */
export const isTransient = (name: string): boolean => /\.(lock|tmp)(\.|$)/i.test(name);

/** Created in ~/.claude up front so Claude never creates them inside an account folder first. */
const PRECREATE_DIRS = [
  'projects', // session transcripts + auto memory (projects/<project>/memory)
  'file-history',
  'todos',
  'plans',
  'skills',
  'commands',
  'agents',
  'ide',
  'session-env',
  'shell-snapshots',
];
const PRECREATE_FILES = ['history.jsonl'];

/** Keys of ~/.claude.json copied once into a new account: preferences only, never login data. */
const SEED_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'theme',
  'editorMode',
  'projects',
  'mcpServers',
  'githubRepoPaths',
  'hasIdeOnboardingBeenShown',
  'autoUpdates',
  'preferredNotifChannel',
  'verbose',
  'diffTool',
];

export interface LinkReport {
  /** Entries correctly linked to ~/.claude. */
  linked: string[];
  /** Entries that exist separately in the account folder (not shared). */
  conflicts: string[];
  /** Entries of ~/.claude missing in the account folder (only when not creating). */
  missing: string[];
  /** Broken links of ours that were removed (see `pruneLinks`). */
  pruned: string[];
  errors: string[];
}

function sameTarget(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

export function ensureSharedRoot(sharedRoot = DEFAULT_CONFIG_DIR): void {
  fs.mkdirSync(sharedRoot, { recursive: true, mode: 0o700 });
  for (const d of PRECREATE_DIRS) {
    const p = path.join(sharedRoot, d);
    if (!pathExists(p)) fs.mkdirSync(p, { recursive: true });
  }
  for (const f of PRECREATE_FILES) {
    const p = path.join(sharedRoot, f);
    if (!pathExists(p)) fs.writeFileSync(p, '', { flag: 'a', mode: 0o600 });
  }
}

/** A link made by `syncLinks`: it points to the entry of the same name directly inside `sharedRoot`. */
function isOurLink(dst: string, name: string, sharedRoot: string): boolean {
  try {
    const target = path.resolve(path.dirname(dst), fs.readlinkSync(dst));
    return path.basename(target) === name && path.dirname(target) === path.resolve(sharedRoot);
  } catch {
    return false;
  }
}

/** The link's target does not exist (an unreadable target is not "gone"). */
function targetGone(link: string): boolean {
  try {
    fs.statSync(link);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Remove links of ours that only do harm: links to a lock or temp file, and links whose entry is
 * gone from `sharedRoot`. Unlinks symlinks only, so no data is ever touched.
 */
function pruneLinks(profileDir: string, sharedRoot: string): string[] {
  const pruned: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(profileDir);
  } catch {
    return pruned;
  }
  for (const name of names.sort()) {
    const dst = path.join(profileDir, name);
    try {
      if (!fs.lstatSync(dst).isSymbolicLink() || !isOurLink(dst, name, sharedRoot)) continue;
      if (!isTransient(name) && !targetGone(dst)) continue;
      fs.unlinkSync(dst);
      pruned.push(name);
    } catch {
      /* ignore */
    }
  }
  return pruned;
}

/**
 * Make every shareable entry of `sharedRoot` a symlink inside `profileDir`.
 * Adds links where nothing exists and removes broken links of its own; never moves or deletes data.
 */
export function syncLinks(profileDir: string, exclude: string[], create: boolean, sharedRoot = DEFAULT_CONFIG_DIR): LinkReport {
  const report: LinkReport = { linked: [], conflicts: [], missing: [], pruned: [], errors: [] };
  if (sameTarget(profileDir, sharedRoot)) return report;
  try {
    if (create) {
      ensureSharedRoot(sharedRoot);
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      report.pruned = pruneLinks(profileDir, sharedRoot);
    }
    const skip = new Set([...ALWAYS_SEPARATE, ...exclude]);
    for (const name of fs.readdirSync(sharedRoot).sort()) {
      if (skip.has(name) || isTransient(name)) continue;
      const src = path.join(sharedRoot, name);
      const dst = path.join(profileDir, name);
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(dst);
      } catch {
        st = undefined;
      }
      if (!st) {
        if (!create) {
          report.missing.push(name);
          continue;
        }
        try {
          const dir = fs.statSync(src).isDirectory();
          fs.symlinkSync(src, dst, dir ? 'junction' : 'file');
          report.linked.push(name);
        } catch (e) {
          report.errors.push(`${name}: ${(e as Error).message}`);
        }
        continue;
      }
      if (st.isSymbolicLink() && sameTarget(dst, src)) report.linked.push(name);
      else report.conflicts.push(name);
    }
  } catch (e) {
    report.errors.push((e as Error).message);
  }
  return report;
}

export interface UnifyResult {
  unified: string[];
  backupDir: string;
  errors: string[];
}

/**
 * For entries that exist separately in an account folder: move them to a backup folder,
 * copy their content into ~/.claude WITHOUT overwriting anything, then replace them with links.
 */
export function unifyWithShared(profileDir: string, names: string[], sharedRoot = DEFAULT_CONFIG_DIR): UnifyResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(profileDir, BACKUP_DIR, stamp);
  const result: UnifyResult = { unified: [], backupDir, errors: [] };
  for (const name of names) {
    if (ALWAYS_SEPARATE.includes(name) || isTransient(name)) continue;
    const dst = path.join(profileDir, name);
    const src = path.join(sharedRoot, name);
    try {
      if (!pathExists(src)) throw new Error('not present in shared folder');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, name);
      fs.renameSync(dst, backup);
      const st = fs.lstatSync(backup);
      if (!st.isSymbolicLink()) {
        if (st.isDirectory()) {
          fs.cpSync(backup, src, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
        } else if (name.endsWith('.jsonl')) {
          const extra = fs.readFileSync(backup, 'utf8');
          if (extra.trim()) {
            const cur = fs.readFileSync(src, 'utf8');
            const sep = cur && !cur.endsWith('\n') ? '\n' : '';
            fs.appendFileSync(src, sep + (extra.endsWith('\n') ? extra : extra + '\n'));
          }
        }
        // other files: the shared version wins, the account's copy stays in the backup folder
      }
      const dir = fs.statSync(src).isDirectory();
      fs.symlinkSync(src, dst, dir ? 'junction' : 'file');
      result.unified.push(name);
    } catch (e) {
      result.errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return result;
}

/** Remove our symlinks from an account folder (used before deleting it, so shared data can never be touched). */
export function removeLinks(profileDir: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(profileDir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(profileDir, name);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** One-time copy of preferences from ~/.claude.json into a brand-new account (no login data). */
export function seedGlobalConfig(profileDir: string): boolean {
  const target = path.join(profileDir, '.claude.json');
  if (pathExists(target)) return false;
  const src = readJsonFile<Record<string, unknown>>(path.join(os.homedir(), '.claude.json'));
  if (!src) return false;
  const seed: Record<string, unknown> = {};
  for (const k of SEED_KEYS) if (k in src) seed[k] = src[k];
  if (!Object.keys(seed).length) return false;
  writeFileAtomic(target, JSON.stringify(seed, null, 2) + '\n', 0o600);
  return true;
}
