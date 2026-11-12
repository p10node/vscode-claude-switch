/**
 * Serial job queue with a minimum gap between two runs. Jobs are keyed, so the same key is
 * never queued twice; a key already queued can be moved to the front. No vscode import: unit-tested.
 */

export interface SpacedQueueOptions<K> {
  run: (key: K, quiet: boolean) => Promise<void>;
  /** Gap between the end of one run and the start of the next, read before every run. */
  spacingMs: () => number;
  /** Called whenever the set of queued keys changes (for rendering). */
  onChange?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface EnqueueOptions {
  /** Run before everything already queued. */
  front?: boolean;
  /** Background run: a loud run (false) wins when the same key is queued both ways. */
  quiet?: boolean;
}

interface Job<K> {
  key: K;
  quiet: boolean;
  done: Promise<void>;
  resolve: () => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SpacedQueue<K> {
  private readonly jobs: Job<K>[] = [];
  private worker: Promise<void> | undefined;
  private lastRunAt = 0;
  private current: K | undefined;
  private disposed = false;

  constructor(private readonly o: SpacedQueueOptions<K>) {}

  /** Resolves when every given key has run (or was dropped by `clear`/`dispose`). */
  enqueue(keys: K[], opts: EnqueueOptions = {}): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const quiet = !!opts.quiet;
    const waits: Promise<void>[] = [];
    let changed = false;
    // Keep the caller's order when inserting at the front: [a, b] → a runs before b.
    const list = opts.front ? [...keys].reverse() : keys;
    for (const key of list) {
      const i = this.jobs.findIndex((j) => j.key === key);
      if (i >= 0) {
        const job = this.jobs[i];
        if (!quiet) job.quiet = false;
        if (opts.front && i > 0) {
          this.jobs.splice(i, 1);
          this.jobs.unshift(job);
        }
        waits.push(job.done);
        continue;
      }
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      const job: Job<K> = { key, quiet, done, resolve };
      if (opts.front) this.jobs.unshift(job);
      else this.jobs.push(job);
      waits.push(done);
      changed = true;
    }
    if (changed) this.o.onChange?.();
    this.start();
    return Promise.all(waits).then(() => undefined);
  }

  /** Queued and not yet running. */
  has(key: K): boolean {
    return this.jobs.some((j) => j.key === key);
  }

  get running(): K | undefined {
    return this.current;
  }

  get size(): number {
    return this.jobs.length;
  }

  /** Drop queued jobs (all, or those the filter accepts). The running job finishes. */
  clear(filter?: (quiet: boolean) => boolean): void {
    let changed = false;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      if (filter && !filter(job.quiet)) continue;
      this.jobs.splice(i, 1);
      job.resolve();
      changed = true;
    }
    if (changed) this.o.onChange?.();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private start(): void {
    if (this.worker) return;
    this.worker = this.loop().finally(() => {
      this.worker = undefined;
      if (this.jobs.length && !this.disposed) this.start();
    });
  }

  private async loop(): Promise<void> {
    const now = this.o.now ?? Date.now;
    const sleep = this.o.sleep ?? defaultSleep;
    while (this.jobs.length && !this.disposed) {
      // Wait first, then pick: a job pushed to the front during the gap runs next.
      const wait = this.lastRunAt ? this.lastRunAt + this.o.spacingMs() - now() : 0;
      if (wait > 0) await sleep(wait);
      const job = this.jobs.shift();
      if (!job) break;
      this.current = job.key;
      this.o.onChange?.();
      try {
        await this.o.run(job.key, job.quiet);
      } catch {
        /* run() reports its own errors */
      } finally {
        this.lastRunAt = now();
        this.current = undefined;
        job.resolve();
      }
    }
  }
}
