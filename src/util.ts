import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Absolute path, no trailing separator, NFC.
 * Claude Code derives the Keychain entry name from the exact CLAUDE_CONFIG_DIR string,
 * so every config dir we hand out must always be spelled the same way.
 */
export function canonicalDir(p: string): string {
  let r = path.resolve(expandHome(p.trim()));
  const root = path.parse(r).root;
  while (r.length > root.length && /[\\/]$/.test(r)) r = r.slice(0, -1);
  return r.normalize('NFC');
}

export function tildify(p: string): string {
  const h = os.homedir();
  if (p === h) return '~';
  return p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

export function slugify(s: string): string {
  const slug = s
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'account';
}

export function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function readJsonFile<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeFileAtomic(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
