import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalDir, isInside, pathExists, slugify, writeFileAtomic } from './util';

export const DEFAULT_ID = 'default';
export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');

export interface Profile {
  id: string;
  name: string;
  /** Value passed as CLAUDE_CONFIG_DIR. Never rewritten once stored: the Keychain entry name depends on it. */
  configDir: string;
  /** Folder created by this extension (inside <root>/profiles) → may be deleted on remove. */
  managed: boolean;
  /** The plain `~/.claude` setup, i.e. CLAUDE_CONFIG_DIR unset. */
  isDefault: boolean;
  /** Name follows the login email until the user renames the account. */
  autoName: boolean;
  /** Just added and never logged in: removed again if the first login does not complete. */
  pending: boolean;
  createdAt?: string;
}

interface StoredProfile {
  id: string;
  name: string;
  configDir: string;
  managed?: boolean;
  autoName?: boolean;
  pending?: boolean;
  createdAt?: string;
}

interface Registry {
  version: 1;
  active: string;
  defaultName?: string;
  profiles: StoredProfile[];
}

const emptyRegistry = (): Registry => ({ version: 1, active: DEFAULT_ID, profiles: [] });

function normalizeRegistry(raw: unknown): Registry {
  const out = emptyRegistry();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Registry>;
  if (typeof r.defaultName === 'string') out.defaultName = r.defaultName;
  if (Array.isArray(r.profiles)) {
    const seen = new Set<string>([DEFAULT_ID]);
    for (const p of r.profiles) {
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.configDir !== 'string') continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.profiles.push({ id: p.id, name: p.name, configDir: p.configDir, managed: !!p.managed, autoName: !!p.autoName, pending: !!p.pending, createdAt: p.createdAt });
    }
  }
  out.active = typeof r.active === 'string' && (r.active === DEFAULT_ID || out.profiles.some((p) => p.id === r.active))
    ? r.active
    : DEFAULT_ID;
  return out;
}

const toProfile = (p: StoredProfile): Profile => ({
  id: p.id,
  name: p.name,
  configDir: p.configDir,
  managed: !!p.managed,
  isDefault: false,
  autoName: !!p.autoName,
  pending: !!p.pending,
  createdAt: p.createdAt,
});

/** Account registry stored as <root>/profiles.json, shared by every VS Code window. */
export class ProfileStore {
  readonly root: string;
  private data: Registry = emptyRegistry();
  private lastRaw: string | undefined;

  constructor(root: string) {
    this.root = canonicalDir(root);
    this.reload();
  }

  get registryFile(): string {
    return path.join(this.root, 'profiles.json');
  }

  get profilesDir(): string {
    return path.join(this.root, 'profiles');
  }

  get exists(): boolean {
    return pathExists(this.registryFile);
  }

  /** Re-read from disk. Returns true when the content changed (e.g. edited by another window). */
  reload(): boolean {
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(this.registryFile, 'utf8');
    } catch {
      raw = undefined;
    }
    if (raw === this.lastRaw) return false;
    this.lastRaw = raw;
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    this.data = normalizeRegistry(parsed);
    return true;
  }

  private save(): void {
    const raw = JSON.stringify(this.data, null, 2) + '\n';
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.registryFile, raw);
    this.lastRaw = raw;
  }

  defaultProfile(): Profile {
    return {
      id: DEFAULT_ID,
      name: this.data.defaultName || 'Default',
      configDir: DEFAULT_CONFIG_DIR,
      managed: false,
      isDefault: true,
      autoName: false,
      pending: false,
    };
  }

  all(): Profile[] {
    return [this.defaultProfile(), ...this.data.profiles.map(toProfile)];
  }

  get(id: string): Profile | undefined {
    return this.all().find((p) => p.id === id);
  }

  get active(): Profile {
    return this.get(this.data.active) ?? this.defaultProfile();
  }

  findByDir(dir: string): Profile | undefined {
    const c = canonicalDir(dir);
    return this.all().find((p) => canonicalDir(p.configDir) === c);
  }

  nameTaken(name: string, exceptId?: string): boolean {
    const n = name.trim().toLowerCase();
    return this.all().some((p) => p.id !== exceptId && p.name.toLowerCase() === n);
  }

  setActive(id: string): void {
    this.data.active = this.get(id) ? id : DEFAULT_ID;
    this.save();
  }

  add(name: string, configDir: string, managed: boolean, opts: { autoName?: boolean; pending?: boolean } = {}): Profile {
    const rec: StoredProfile = {
      id: this.uniqueId(slugify(name)),
      name: name.trim(),
      configDir,
      managed,
      autoName: !!opts.autoName,
      pending: !!opts.pending,
      createdAt: new Date().toISOString(),
    };
    this.data.profiles.push(rec);
    this.save();
    return toProfile(rec);
  }

  /** `auto: true` = automatic rename (keeps following the email); a manual rename stops that. */
  rename(id: string, name: string, opts: { auto?: boolean } = {}): void {
    if (id === DEFAULT_ID) {
      this.data.defaultName = name.trim();
    } else {
      const rec = this.data.profiles.find((p) => p.id === id);
      if (!rec) return;
      rec.name = name.trim();
      rec.autoName = !!opts.auto;
    }
    this.save();
  }

  /** First login completed: the account is kept from now on. */
  confirm(id: string): void {
    const rec = this.data.profiles.find((p) => p.id === id);
    if (!rec?.pending) return;
    rec.pending = false;
    this.save();
  }

  /** `base`, or `base (2)`, `base (3)`… if another account already uses it. */
  uniqueName(base: string, exceptId?: string): string {
    let name = base.trim();
    for (let i = 2; this.nameTaken(name, exceptId); i++) name = `${base.trim()} (${i})`;
    return name;
  }

  remove(id: string): void {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.active === id) this.data.active = DEFAULT_ID;
    this.save();
  }

  /** Fresh, unused folder <root>/profiles/<slug>. */
  allocateManagedDir(name: string): string {
    const base = slugify(name);
    let dir = path.join(this.profilesDir, base);
    for (let i = 2; pathExists(dir); i++) dir = path.join(this.profilesDir, `${base}-${i}`);
    return canonicalDir(dir);
  }

  isManagedDir(dir: string): boolean {
    return isInside(canonicalDir(dir), this.profilesDir);
  }

  private uniqueId(base: string): string {
    const b = base === DEFAULT_ID ? 'default-account' : base;
    let id = b;
    for (let i = 2; this.get(id); i++) id = `${b}-${i}`;
    return id;
  }
}
