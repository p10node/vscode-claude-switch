import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'bun:test';
import { keychainService, parseAuthStatus, parseCachedUsage, parseUsageText } from '../src/claude';
import { syncLinks, unifyWithShared, removeLinks } from '../src/links';
import { SpacedQueue } from '../src/queue';
import { ProfileStore } from '../src/store';
import { canonicalDir, slugify } from '../src/util';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-switch-test-'));

test('parseUsageText reads /usage lines', () => {
  const text = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 12% used · resets 5pm (Asia/Saigon)',
    'Current week (all models): 95% used · resets Nov 12 at 12pm (Asia/Saigon)',
    'Current week (Fable): 100% used',
    '  83%  Start fresh when you switch tasks · run /clear',
  ].join('\n');
  assert.deepStrictEqual(parseUsageText(text), [
    { label: 'Current session', percent: 12, resets: '5pm (Asia/Saigon)' },
    { label: 'Current week (all models)', percent: 95, resets: 'Nov 12 at 12pm (Asia/Saigon)' },
    { label: 'Current week (Fable)', percent: 100, resets: undefined },
  ]);
});

test('parseUsageText ignores logged-out cost summary', () => {
  assert.deepStrictEqual(parseUsageText('Total cost:            $0.0000\nUsage: 0 input, 0 output'), []);
});

test('parseCachedUsage handles limits array and account mismatch', () => {
  const cache = {
    fetchedAtMs: 1794172915622,
    accountUuid: 'acc-1',
    utilization: {
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: 95, resets_at: '2026-11-12T05:00:00Z', scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 100, resets_at: '2026-11-12T05:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    },
  };
  const u = parseCachedUsage(cache, 'acc-1');
  assert.ok(u);
  assert.deepStrictEqual(u.limits.map((l) => [l.label, l.percent]), [
    ['Current week (all models)', 95],
    ['Current week (Fable)', 100],
  ]);
  assert.strictEqual(parseCachedUsage(cache, 'someone-else'), undefined);
  const legacy = parseCachedUsage({ fetchedAtMs: 1, utilization: { five_hour: { utilization: 40.4 }, seven_day: null } });
  assert.deepStrictEqual(legacy?.limits.map((l) => [l.label, l.percent]), [['Current session', 40]]);
});

test('parseAuthStatus tolerates noise around JSON', () => {
  const s = parseAuthStatus('warning: something\n{"loggedIn": true, "email": "a@b.c", "subscriptionType": "max"}\n');
  assert.deepStrictEqual(s, { loggedIn: true, authMethod: undefined, email: 'a@b.c', orgName: undefined, subscriptionType: 'max' });
  assert.strictEqual(parseAuthStatus('not json'), undefined);
});

test('keychainService matches Claude Code naming', () => {
  const dir = '/Users/x/.claude-switch/profiles/work';
  const expected = execFileSync('/bin/sh', ['-c', `printf %s '${dir}' | shasum -a 256 | cut -c1-8`]).toString().trim();
  assert.strictEqual(keychainService({ id: 'w', name: 'w', configDir: dir, managed: true, isDefault: false, autoName: false, pending: false }), `Claude Code-credentials-${expected}`);
  assert.strictEqual(keychainService({ id: 'default', name: 'd', configDir: '', managed: false, isDefault: true, autoName: false, pending: false }), 'Claude Code-credentials');
});

test('syncLinks shares everything except login data and never overwrites', () => {
  const shared = tmp();
  const prof = tmp();
  fs.mkdirSync(path.join(shared, 'projects', 'p1', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'projects', 'p1', 'memory', 'MEMORY.md'), 'shared memory');
  fs.writeFileSync(path.join(shared, 'settings.json'), '{}');
  fs.writeFileSync(path.join(shared, '.credentials.json'), 'SECRET');
  fs.mkdirSync(path.join(shared, 'telemetry'));
  fs.mkdirSync(path.join(prof, 'skills')); // pre-existing separate dir → conflict
  fs.writeFileSync(path.join(prof, 'skills', 'mine.md'), 'x');

  const r = syncLinks(prof, ['telemetry'], true, shared);
  assert.ok(r.linked.includes('projects'));
  assert.ok(r.linked.includes('settings.json'));
  assert.ok(r.linked.includes('history.jsonl')); // pre-created
  assert.deepStrictEqual(r.conflicts, ['skills']);
  assert.ok(!fs.existsSync(path.join(prof, '.credentials.json')));
  assert.ok(!fs.existsSync(path.join(prof, 'telemetry')));
  assert.strictEqual(fs.readFileSync(path.join(prof, 'projects', 'p1', 'memory', 'MEMORY.md'), 'utf8'), 'shared memory');

  // memory written through the account folder lands in the shared folder
  fs.writeFileSync(path.join(prof, 'projects', 'p1', 'memory', 'new.md'), 'from account');
  assert.strictEqual(fs.readFileSync(path.join(shared, 'projects', 'p1', 'memory', 'new.md'), 'utf8'), 'from account');

  // idempotent
  const again = syncLinks(prof, ['telemetry'], true, shared);
  assert.deepStrictEqual(again.conflicts, ['skills']);
  assert.strictEqual(again.errors.length, 0);
});

test('unifyWithShared merges without overwriting and keeps a backup', () => {
  const shared = tmp();
  const prof = tmp();
  fs.mkdirSync(path.join(shared, 'skills'));
  fs.writeFileSync(path.join(shared, 'skills', 'same.md'), 'shared');
  fs.writeFileSync(path.join(shared, 'history.jsonl'), '{"a":1}\n');
  fs.mkdirSync(path.join(prof, 'skills'));
  fs.writeFileSync(path.join(prof, 'skills', 'same.md'), 'account');
  fs.writeFileSync(path.join(prof, 'skills', 'only.md'), 'only');
  fs.writeFileSync(path.join(prof, 'history.jsonl'), '{"b":2}');

  const r = unifyWithShared(prof, ['skills', 'history.jsonl'], shared);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(fs.readFileSync(path.join(shared, 'skills', 'same.md'), 'utf8'), 'shared');
  assert.strictEqual(fs.readFileSync(path.join(shared, 'skills', 'only.md'), 'utf8'), 'only');
  assert.strictEqual(fs.readFileSync(path.join(shared, 'history.jsonl'), 'utf8'), '{"a":1}\n{"b":2}\n');
  assert.ok(fs.lstatSync(path.join(prof, 'skills')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(r.backupDir, 'skills', 'same.md'), 'utf8'), 'account');

  removeLinks(prof);
  assert.ok(!fs.existsSync(path.join(prof, 'skills')));
  assert.ok(fs.existsSync(path.join(shared, 'skills', 'only.md')));
});

test('ProfileStore add / rename / remove / active', () => {
  const root = tmp();
  const s = new ProfileStore(root);
  assert.strictEqual(s.active.isDefault, true);
  const dir = s.allocateManagedDir('Công việc');
  assert.strictEqual(path.basename(dir), 'cong-viec');
  const p = s.add('Công việc', dir, true);
  s.setActive(p.id);
  const s2 = new ProfileStore(root);
  assert.strictEqual(s2.active.id, p.id);
  assert.ok(s2.isManagedDir(dir));
  assert.ok(s2.nameTaken('công VIỆC'));
  s2.rename(p.id, 'Work');
  s2.remove(p.id);
  assert.strictEqual(s2.active.isDefault, true);
  assert.strictEqual(new ProfileStore(root).all().length, 1);
});

test('canonicalDir / slugify', () => {
  assert.strictEqual(canonicalDir('~/a/b/'), path.join(os.homedir(), 'a', 'b'));
  assert.strictEqual(slugify('  Đức Anh!! '), 'duc-anh');
  assert.strictEqual(slugify('***'), 'account');
});

test('resolveClaudeBinary: missing configured path → undefined (triggers the install notice)', () => {
  const { resolveClaudeBinary } = require('../src/claude') as typeof import('../src/claude');
  assert.strictEqual(resolveClaudeBinary('/nonexistent/claude'), undefined);
  assert.strictEqual(resolveClaudeBinary('definitely-not-a-real-binary-xyz'), undefined);
  const dir = tmp();
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(resolveClaudeBinary(fake), fake);
  assert.strictEqual(resolveClaudeBinary('', [fake]) !== undefined, true);
});

test('looksOutdated detects CLIs without `claude auth`', () => {
  const { looksOutdated } = require('../src/claude') as typeof import('../src/claude');
  assert.strictEqual(looksOutdated({ loggedIn: false, error: "error: unknown command 'auth'" }), true);
  assert.strictEqual(looksOutdated({ loggedIn: false }), false);
  assert.strictEqual(looksOutdated(undefined), false);
});

test('sessions: cpu time parsing and chat detection', () => {
  const { parseCpuTime, isClaudeChatCommand } = require('../src/sessions') as typeof import('../src/sessions');
  assert.strictEqual(parseCpuTime('0:04.41'), 4.41);
  assert.strictEqual(parseCpuTime('01:02:03'), 3723);
  assert.strictEqual(parseCpuTime('1-00:00:10'), 86410);
  assert.ok(isClaudeChatCommand('/x/native-binary/claude --output-format stream-json --verbose --input-format stream-json'));
  assert.ok(!isClaudeChatCommand('/opt/homebrew/bin/claude -p /usage'));
});

test('sessions: claudeCodeChats finds real children of a host pid', async () => {
  const { claudeCodeChats } = require('../src/sessions') as typeof import('../src/sessions');
  const none = await claudeCodeChats(10, 999_999_999);
  if (process.platform !== 'win32') assert.deepStrictEqual(none, { count: 0, busy: 0 });
});

test('sessions: status file decides busy/idle', () => {
  const { sessionStatus } = require('../src/sessions') as typeof import('../src/sessions');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, status: 'busy' }));
  assert.strictEqual(sessionStatus(4242, ['/nonexistent', dir]), 'busy');
  assert.strictEqual(sessionStatus(1, [dir]), undefined);
});

test('ProfileStore: auto names follow email until renamed by hand', () => {
  const s = new ProfileStore(tmp());
  const p = s.add(s.uniqueName('New account'), '/tmp/x', true, { autoName: true });
  assert.strictEqual(s.get(p.id)?.autoName, true);
  assert.strictEqual(s.uniqueName('New account'), 'New account (2)');
  s.rename(p.id, 'you@example.com', { auto: true });
  assert.strictEqual(s.get(p.id)?.autoName, true);
  s.rename(p.id, 'Work');
  assert.strictEqual(s.get(p.id)?.autoName, false);
  assert.strictEqual(s.uniqueName('Work', p.id), 'Work');
});

test('ProfileStore: pending accounts are confirmed after the first login', () => {
  const root = tmp();
  const s = new ProfileStore(root);
  const p = s.add('New account', '/tmp/y', true, { autoName: true, pending: true });
  assert.strictEqual(new ProfileStore(root).get(p.id)?.pending, true);
  s.confirm(p.id);
  assert.strictEqual(new ProfileStore(root).get(p.id)?.pending, false);
});

// ───────────────────────── SpacedQueue ─────────────────────────

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    tick: (ms: number) => (t += ms),
    sleeps,
  };
}

test('SpacedQueue runs one job at a time with a gap, dedupes keys, manual check goes first', async () => {
  const clock = fakeClock();
  const ran: string[] = [];
  let concurrent = 0;
  let peak = 0;
  const q = new SpacedQueue<string>({
    now: clock.now,
    sleep: clock.sleep,
    spacingMs: () => 10_000,
    run: async (key) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      ran.push(key);
      clock.tick(1000); // the run itself takes a second
      await Promise.resolve();
      concurrent--;
    },
  });
  const all = q.enqueue(['a', 'b', 'c'], { quiet: true });
  assert.ok(q.has('b') && q.has('c'));
  const again = q.enqueue(['b'], { quiet: true }); // already queued → no duplicate
  assert.strictEqual(q.size, 2);
  const manual = q.enqueue(['c'], { front: true }); // jumps ahead of b
  await Promise.all([all, again, manual]);
  assert.deepStrictEqual(ran, ['a', 'c', 'b']);
  assert.strictEqual(peak, 1);
  assert.deepStrictEqual(clock.sleeps, [10_000, 10_000]); // no wait before the first run
  assert.strictEqual(q.size, 0);
  assert.strictEqual(q.running, undefined);
});

test('SpacedQueue clear drops only the matching jobs and resolves their promises', async () => {
  const clock = fakeClock();
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const q = new SpacedQueue<string>({
    now: clock.now,
    sleep: clock.sleep,
    spacingMs: () => 0,
    run: async (key) => {
      ran.push(key);
      if (key === 'first') await gate;
    },
  });
  const first = q.enqueue(['first']);
  const auto = q.enqueue(['x', 'y'], { quiet: true });
  const loud = q.enqueue(['z']);
  q.clear((quiet) => quiet); // like turning the background scan off
  await auto; // dropped jobs resolve right away
  assert.ok(!q.has('x') && !q.has('y') && q.has('z'));
  release();
  await Promise.all([first, loud]);
  assert.deepStrictEqual(ran, ['first', 'z']);
});

test('SpacedQueue dispose stops after the running job', async () => {
  const ran: string[] = [];
  const q = new SpacedQueue<string>({
    spacingMs: () => 0,
    sleep: async () => {},
    run: async (key) => {
      ran.push(key);
      if (key === 'a') q.dispose();
    },
  });
  await q.enqueue(['a', 'b']);
  assert.deepStrictEqual(ran, ['a']);
  await q.enqueue(['c']); // no-op after dispose
  assert.deepStrictEqual(ran, ['a']);
});
