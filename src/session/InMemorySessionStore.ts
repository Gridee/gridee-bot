import { LockTimeoutError, SessionStoreError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { ISessionStore, LockOptions } from './ISessionStore';
import { type Phone, type SessionState, SessionStateSchema } from './types';

interface MemoryEntry {
  state: SessionState;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Per-key FIFO mutex. Each `acquire` waits until prior holders for the same
 * key have released. Times out (rejecting) if it cannot acquire in time, and
 * cleanly removes itself from the queue on timeout so it doesn't block the
 * next waiter.
 */
class KeyedMutex {
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, Array<() => void>>();

  acquire(key: string, timeoutMs: number): Promise<() => void> {
    if (!this.active.has(key)) {
      this.active.add(key);
      return Promise.resolve(() => this.release(key));
    }

    return new Promise<() => void>((resolve, reject) => {
      // Hoisted so onTurn can clear it; assigned synchronously below
      let timer: NodeJS.Timeout | null = null;

      const onTurn = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(() => this.release(key));
      };

      timer = setTimeout(() => {
        // Remove ourselves from queue if still present
        const queue = this.queues.get(key);
        if (queue) {
          const idx = queue.indexOf(onTurn);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) this.queues.delete(key);
        }
        reject(new LockTimeoutError(`Could not acquire session lock for "${key}" within ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't keep the event loop alive just for lock timeouts
      timer.unref?.();

      const queue = this.queues.get(key) ?? [];
      queue.push(onTurn);
      this.queues.set(key, queue);
    });
  }

  private release(key: string): void {
    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.queues.delete(key);
      // Hand active flag straight to the next waiter — no gap window
      next();
    } else {
      this.active.delete(key);
      this.queues.delete(key);
    }
  }

  /** Test helper. */
  hasActive(key: string): boolean {
    return this.active.has(key);
  }
}

export interface InMemorySessionStoreOptions {
  /** Session TTL in milliseconds. */
  ttlMs: number;
}

/**
 * In-memory session store. Suitable for development, tests, and single-process
 * deployments only. Data is lost on process exit.
 */
export class InMemorySessionStore implements ISessionStore {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly mutex = new KeyedMutex();
  private readonly ttlMs: number;
  private closed = false;

  constructor(opts: InMemorySessionStoreOptions) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new SessionStoreError(`Invalid ttlMs: ${opts.ttlMs}`);
    }
    this.ttlMs = opts.ttlMs;
  }

  async get(phone: Phone): Promise<SessionState | null> {
    this.assertOpen();
    const entry = this.store.get(phone);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      // Expired — clean up and return null. The timer should fire too, but a
      // get() racing with the timer should still see null.
      this.deleteEntry(phone);
      return null;
    }

    // Validate on read for parity with Redis store. If our own in-memory data
    // is invalid, that's a programmer bug somewhere — log and self-heal.
    const result = SessionStateSchema.safeParse(entry.state);
    if (!result.success) {
      logger.error({ errors: result.error.issues }, 'In-memory session corrupt; deleting');
      this.deleteEntry(phone);
      return null;
    }
    return result.data;
  }

  async set(phone: Phone, state: SessionState): Promise<void> {
    this.assertOpen();
    // Always overwrite updatedAt to now — caller can't fake it
    const candidate: SessionState = { ...state, updatedAt: Date.now() };
    const result = SessionStateSchema.safeParse(candidate);
    if (!result.success) {
      throw new SessionStoreError(
        `Invalid session state: ${result.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    // Clear any existing entry's timer first to prevent leaks
    this.deleteEntry(phone);

    const expiresAt = Date.now() + this.ttlMs;
    const timer = setTimeout(() => {
      // Self-clean on TTL expiry. Guard against the entry having been
      // replaced or cleared between scheduling and firing.
      const cur = this.store.get(phone);
      if (cur && cur.timer === timer) this.store.delete(phone);
    }, this.ttlMs);
    timer.unref?.();

    this.store.set(phone, { state: result.data, expiresAt, timer });
  }

  async clear(phone: Phone): Promise<void> {
    this.assertOpen();
    this.deleteEntry(phone);
  }

  async withLock<T>(phone: Phone, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
    this.assertOpen();
    const timeoutMs = opts.timeoutMs ?? 5000;
    // ttlMs is intentionally ignored: a crashed in-memory process loses everything.

    const release = await this.mutex.acquire(phone, timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.store) {
      clearTimeout(entry.timer);
    }
    this.store.clear();
  }

  /** Test helper: number of stored sessions. */
  size(): number {
    return this.store.size;
  }

  private deleteEntry(phone: string): void {
    const entry = this.store.get(phone);
    if (entry) {
      clearTimeout(entry.timer);
      this.store.delete(phone);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionStoreError('Session store has been closed');
  }
}
