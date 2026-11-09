/**
 * Open Claude Code chats in THIS window.
 *
 * The official Claude Code extension runs every chat as a child process of the extension host
 * (`claude … --output-format stream-json …`). We run in that same extension host, so the chats
 * of this window are exactly the children of `process.pid` with that command line.
 *
 * "Busy" comes from the status Claude Code writes to <config>/sessions/<pid>.json
 * ("idle" while waiting for you, "busy" while working). When that file is missing (older
 * versions), it falls back to a guess from the CPU time of the chat and its tools.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface Proc {
  pid: number;
  ppid: number;
  cpu: number; // seconds of CPU time
  cmd: string;
}

export interface ChatActivity {
  /** Open chats in this window. */
  count: number;
  /** Chats that used CPU during the sample (a reply or tool is probably running). */
  busy: number;
}

/** "1-02:03:04", "02:03:04", "03:04", "0:04.41" → seconds. */
export function parseCpuTime(s: string): number {
  let days = 0;
  let rest = s.trim();
  const dash = rest.indexOf('-');
  if (dash > 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return days * 86_400 + secs;
}

export function isClaudeChatCommand(cmd: string): boolean {
  return /claude/i.test(cmd) && /--output-format(?:=|\s+)stream-json/.test(cmd);
}

function psTable(): Promise<Proc[] | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/ps',
      ['-A', '-o', 'pid=,ppid=,time=,command='],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const out: Proc[] = [];
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
          if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: parseCpuTime(m[3]), cmd: m[4] });
        }
        resolve(out);
      },
    );
    child.stdin?.end();
  });
}

function treeCpu(table: Proc[], root: number): number {
  const children = new Map<number, Proc[]>();
  for (const p of table) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  let total = 0;
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = table.find((p) => p.pid === pid);
    if (self) total += self.cpu;
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return total;
}

/** Status Claude Code reports for a chat process, looked up in each candidate config folder. */
export function sessionStatus(pid: number, configDirs: string[]): string | undefined {
  for (const dir of configDirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${pid}.json`), 'utf8')) as { pid?: unknown; status?: unknown };
      if (j.pid === pid && typeof j.status === 'string') return j.status;
    } catch {
      /* not in this folder */
    }
  }
  return undefined;
}

/** Returns undefined when it cannot tell (e.g. on Windows). */
export async function claudeCodeChats(sampleMs = 1500, host = process.pid, configDirs: string[] = []): Promise<ChatActivity | undefined> {
  const first = await psTable();
  if (!first) return undefined;
  const chats = first.filter((p) => p.ppid === host && isClaudeChatCommand(p.cmd));
  if (!chats.length) return { count: 0, busy: 0 };

  let busy = 0;
  const unknown: Proc[] = [];
  for (const c of chats) {
    const status = sessionStatus(c.pid, configDirs);
    if (status === undefined) unknown.push(c);
    else if (status !== 'idle') busy++;
  }
  if (!unknown.length) return { count: chats.length, busy };

  await new Promise((r) => setTimeout(r, sampleMs));
  const second = await psTable();
  if (!second) return { count: chats.length, busy };
  let count = chats.length - unknown.length;
  for (const c of unknown) {
    if (!second.some((p) => p.pid === c.pid)) continue;
    count++;
    const used = treeCpu(second, c.pid) - treeCpu(first, c.pid);
    if (used / (sampleMs / 1000) >= 0.02) busy++;
  }
  return { count, busy };
}
