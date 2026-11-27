import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'bun:test';
import { fetchUsage, keychainService, parseAuthStatus, parseCachedUsage, parseUsageText, USAGE_REQUEST_FAILED } from '../src/claude';
import { isTransient, syncLinks, unifyWithShared, removeLinks } from '../src/links';
import { limitKind, parseResetText, resetTime, rowReset, sortByWeeklyReset, weeklyResetAt } from '../src/model';
import { SpacedQueue } from '../src/queue';
import { Profile, ProfileStore } from '../src/store';
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
  assert.strictEqual(u.limits[0].resetsAt, Date.parse('2026-11-12T05:00:00Z'));
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

test('syncLinks never links locks or temp files and removes its broken links', () => {
  for (const n of ['.oauth_refresh.lock', '.oauth_refresh.lock.owner', 'history.jsonl.lock', 'settings.json.tmp.4242']) assert.ok(isTransient(n), n);
  for (const n of ['settings.json', 'history.jsonl', 'plugins', 'blocklist.json', 'tmp']) assert.ok(!isTransient(n), n);

  const shared = tmp();
  const prof = tmp();
  fs.mkdirSync(path.join(shared, '.oauth_refresh.lock')); // a token refresh is running in ~/.claude
  fs.writeFileSync(path.join(shared, '.oauth_refresh.lock.owner'), '{}');
  fs.writeFileSync(path.join(shared, 'settings.json.tmp.4242'), '{}');
  fs.writeFileSync(path.join(shared, 'settings.json'), '{}');
  // left behind by an older version: links to a lock, and to an entry that is gone from ~/.claude
  fs.symlinkSync(path.join(shared, '.oauth_refresh.lock'), path.join(prof, '.oauth_refresh.lock'));
  fs.symlinkSync(path.join(shared, '.oauth_refresh.lock.owner'), path.join(prof, '.oauth_refresh.lock.owner'));
  fs.symlinkSync(path.join(shared, 'gone'), path.join(prof, 'gone'));
  // not ours: never touched
  fs.symlinkSync(path.join(prof, 'nowhere'), path.join(prof, 'foreign'));
  fs.writeFileSync(path.join(prof, 'own.lock'), 'x');

  const r = syncLinks(prof, [], true, shared);
  assert.deepStrictEqual(r.pruned, ['.oauth_refresh.lock', '.oauth_refresh.lock.owner', 'gone']);
  assert.deepStrictEqual(r.conflicts, []);
  assert.ok(r.linked.includes('settings.json'));
  for (const n of ['.oauth_refresh.lock', '.oauth_refresh.lock.owner', 'settings.json.tmp.4242', 'gone']) {
    assert.throws(() => fs.lstatSync(path.join(prof, n)), n);
  }
  assert.ok(fs.lstatSync(path.join(prof, 'foreign')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(prof, 'own.lock'), 'utf8'), 'x');
  assert.ok(fs.existsSync(path.join(shared, '.oauth_refresh.lock'))); // the original is untouched
  fs.mkdirSync(path.join(prof, '.oauth_refresh.lock')); // Claude Code can take its own lock again

  assert.deepStrictEqual(syncLinks(prof, [], true, shared).pruned, []);
});

test('fetchUsage tells a failed usage request from an account without limits', async () => {
  const SUBSCRIPTION = 'You are currently using your subscription to power your Claude Code usage';
  const fake = (script: string): { bin: string; p: Profile } => {
    const dir = tmp();
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { bin, p: { id: 'a', name: 'a', configDir: dir, managed: true, isDefault: false, autoName: false, pending: false } };
  };
  const cache = (fetchedAtMs: string, limits: string): string =>
    `printf '{"cachedUsageUtilization":{"fetchedAtMs":%s,"utilization":{"limits":${limits}}}}' ${fetchedAtMs} > "$CLAUDE_CONFIG_DIR/.claude.json"`;
  const WEEKLY = '[{"kind":"weekly_all","group":"weekly","percent":42,"resets_at":"2026-12-03T05:00:00Z"}]';

  // limits printed
  let f = fake(`echo '${SUBSCRIPTION}'; echo; echo 'Current week (all models): 6% used · resets Dec 3 at 12pm (Asia/Saigon)'`);
  let u = await fetchUsage(f.bin, f.p);
  assert.deepStrictEqual([u.source, u.limits.map((l) => l.percent)], ['cli', [6]]);

  // usage request failed: exit 0, no limits, Claude Code's cache untouched (absent, or from an earlier run)
  f = fake(`echo '${SUBSCRIPTION}'; echo; echo "What's contributing to your usage?"`);
  await assert.rejects(fetchUsage(f.bin, f.p), { message: USAGE_REQUEST_FAILED });
  f = fake(`${cache('1000', WEEKLY)}; echo 'Usage unavailable'`);
  await assert.rejects(fetchUsage(f.bin, f.p), { message: USAGE_REQUEST_FAILED });

  // no limits printed, but Claude Code cached this run's answer
  f = fake(`${cache('"$(date +%s)000"', WEEKLY)}; echo '${SUBSCRIPTION}'`);
  u = await fetchUsage(f.bin, f.p);
  assert.deepStrictEqual([u.source, u.limits.map((l) => l.percent)], ['cache', [42]]);
  f = fake(`${cache('"$(date +%s)000"', '[]')}; echo '${SUBSCRIPTION}'`);
  assert.deepStrictEqual((await fetchUsage(f.bin, f.p)).limits, []);

  // API key: no subscription, no limits
  f = fake(`echo 'Total cost:            $0.0000'`);
  assert.deepStrictEqual((await fetchUsage(f.bin, f.p)).limits, []);

  f = fake(`echo 'Not logged in' >&2; exit 1`);
  await assert.rejects(fetchUsage(f.bin, f.p), { message: 'Not logged in' });
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

test('rowReset: weekly date by default, session time on demand, other kind only as a fallback', () => {
  const cli = [
    { label: 'Current session', percent: 30, resets: '5pm (Asia/Saigon)' },
    { label: 'Current week (all models)', percent: 66, resets: 'Nov 19 at 12pm (Asia/Saigon)' },
    { label: 'Current week (Fable)', percent: 48 },
  ];
  assert.strictEqual(limitKind('Current session'), 'session');
  assert.strictEqual(limitKind('Current week (Fable)'), 'weekly');
  assert.strictEqual(limitKind('Extra usage'), undefined);
  assert.strictEqual(rowReset(cli, 'weekly')?.text, 'Nov 19');
  assert.strictEqual(rowReset(cli, 'weekly')?.limit.label, 'Current week (all models)');
  assert.strictEqual(rowReset(cli, 'session')?.text, '5pm');

  // Claude Code's cache format; a session that ends after midnight still shows only the time.
  const cache = [
    { label: 'Current session', percent: 3, resets: 'Nov 16, 1:00 AM' },
    { label: 'Current week (all models)', percent: 0, resets: 'Nov 22, 12:00 PM' },
  ];
  assert.strictEqual(rowReset(cache, 'weekly')?.text, 'Nov 22');
  assert.strictEqual(rowReset(cache, 'session')?.text, '1:00 AM');
  assert.strictEqual(rowReset([{ label: 'Current week (all models)', percent: 9, resets: '9:59 PM' }], 'weekly')?.text, '9:59 PM');

  // No session limit on this plan → the weekly date; a session that has not started → nothing.
  const weeklyOnly = [{ label: 'Current week (all models)', percent: 36, resets: 'Nov 19 at 12pm (Asia/Saigon)' }];
  assert.strictEqual(rowReset(weeklyOnly, 'session')?.text, 'Nov 19');
  assert.strictEqual(rowReset([{ label: 'Current session', percent: 0 }, ...weeklyOnly], 'session'), undefined);
  // Weekly reset unknown: never pass the session reset off as the weekly one.
  assert.strictEqual(rowReset([{ label: 'Current session', percent: 5, resets: '5pm' }, { label: 'Current week (all models)', percent: 0 }], 'weekly'), undefined);
  assert.strictEqual(rowReset([], 'weekly'), undefined);
});

test('parseResetText reads reset texts as local time around the fetch time', () => {
  const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();
  const ref = at(2026, 10, 15, 21, 0); // Nov 15, 9pm
  assert.strictEqual(parseResetText('Nov 19 at 12pm (Asia/Saigon)', ref), at(2026, 10, 19, 12));
  assert.strictEqual(parseResetText('Nov 12 at 11:59am (Asia/Saigon)', ref), at(2026, 10, 12, 11, 59));
  assert.strictEqual(parseResetText('Nov 20 at 6:00 PM', ref), at(2026, 10, 20, 18));
  assert.strictEqual(parseResetText('Nov 16, 1:00 AM', ref), at(2026, 10, 16, 1));
  assert.strictEqual(parseResetText('Nov 22', ref), at(2026, 10, 22));
  assert.strictEqual(parseResetText('12am', ref), at(2026, 10, 15, 0));
  assert.strictEqual(parseResetText('5pm (Asia/Saigon)', ref), at(2026, 10, 15, 17));
  assert.strictEqual(parseResetText('17:30', ref), at(2026, 10, 15, 17, 30));
  // Around New Year the year is the one closest to the fetch time.
  assert.strictEqual(parseResetText('Jan 2 at 9am', at(2026, 11, 29)), at(2027, 0, 2, 9));
  assert.strictEqual(parseResetText('Dec 30 at 9am', at(2027, 0, 1)), at(2026, 11, 30, 9));
  for (const junk of ['', 'soon', 'in 3 hours', 'Foo 12 at 5pm', 'Nov 12 at 25pm', '12']) {
    assert.strictEqual(parseResetText(junk, ref), undefined, junk);
  }
});

test('sortByWeeklyReset: soonest weekly reset first, unknown last in their own order', () => {
  const fetchedAt = new Date(2026, 10, 15, 21, 0).getTime();
  const exact = new Date(2026, 10, 17, 12, 59).getTime();
  // The exact time wins over the text; the session reset is never used.
  assert.strictEqual(resetTime({ label: 'Current week (all models)', percent: 1, resets: 'Nov 30 at 1pm', resetsAt: exact }, fetchedAt), exact);
  const accounts = [
    { name: 'default', limits: [{ label: 'Current week (all models)', percent: 36, resets: 'Nov 19 at 12pm (Asia/Saigon)' }] },
    { name: 'no quota yet', limits: [] },
    { name: 'team', limits: [{ label: 'Current session', percent: 30, resets: '10pm' }, { label: 'Current week (all models)', percent: 66, resets: 'Nov 17 at 12:59 PM', resetsAt: exact }] },
    { name: 'session only', limits: [{ label: 'Current session', percent: 3, resets: 'Nov 16 at 1:00 AM' }] },
    { name: 'fable first', limits: [{ label: 'Current week (all models)', percent: 0 }, { label: 'Current week (Fable)', percent: 0, resets: 'Nov 16 at 3pm' }] },
    { name: 'same day as default', limits: [{ label: 'Current week (all models)', percent: 5, resets: 'Nov 19 at 12pm (Asia/Saigon)' }] },
  ];
  assert.strictEqual(weeklyResetAt(accounts[3].limits, fetchedAt), undefined);
  const sorted = sortByWeeklyReset(accounts, (a) => weeklyResetAt(a.limits, fetchedAt)).map((a) => a.name);
  assert.deepStrictEqual(sorted, ['fable first', 'team', 'default', 'same day as default', 'no quota yet', 'session only']);
  assert.strictEqual(accounts[0].name, 'default'); // input untouched
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
