import { randomUUID } from 'crypto';
import { createClient, type RedisClientType } from 'redis';
import { LockTimeoutError, SessionStoreError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { ISessionStore, LockOptions } from './ISessionStore';
import { type Phone, type SessionState, SessionStateSchema } from './types';

/**
 * Compare-and-delete: only release the lock if it still holds OUR token.
 * Prevents the classic bug: holder's TTL expires → another caller acquires
 * → original holder finishes and deletes the new caller's lock.
 */
const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

export interface RedisSessionStoreOptions {
  url: string;
  /** Session TTL in seconds. Redis stores TTL in seconds natively. */
  ttlSeconds: number;
  /** Optional override for the key namespace, e.g. 'gridee:dev'. Default: 'gridee'. */
  namespace?: string;
}

/**
 * Redis-backed session store. Suitable for production and multi-process tests.
 * The constructor does NOT connect immediately — connection is lazy on first
 * call. This avoids surprising failures during DI wiring at boot.
 */
export class RedisSessionStore implements ISessionStore {
  private readonly client: RedisClientType;
  private readonly ttlSeconds: number;
  private readonly namespace: string;
  private connectPromise: Promise<void> | null = null;
  private closed = false;

  constructor(opts: RedisSessionStoreOptions) {
    if (!Number.isFinite(opts.ttlSeconds) || opts.ttlSeconds <= 0) {
      throw new SessionStoreError(`Invalid ttlSeconds: ${opts.ttlSeconds}`);
    }
    if (!opts.url) throw new SessionStoreError('Redis URL is required');

    this.ttlSeconds = Math.floor(opts.ttlSeconds);
    this.namespace = opts.namespace ?? 'gridee';
    this.client = createClient({ url: opts.url });

    // Errors after connection — log, don't crash. The next operation will see
    // the disconnect and surface a meaningful error.
    this.client.on('error', (err: Error) => {
      logger.error({ err: err.message }, 'Redis client error');
    });
  }

  private sessionKey(phone: Phone): string {
    return `${this.namespace}:session:${phone}`;
  }

  private lockKey(phone: Phone): string {
    return `${this.namespace}:lock:session:${phone}`;
  }

  /**
   * Lazy single-flight connect. All callers await the same in-flight connection
   * promise — no races where two operations both call `client.connect()`.
   */
  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new SessionStoreError('Session store has been closed');
    if (this.client.isOpen) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        try {
          await this.client.connect();
        } catch (err) {
          // Reset so a retry can connect — avoid getting stuck on a stale failed promise
          this.connectPromise = null;
          throw new SessionStoreError(`Redis connection failed: ${(err as Error).message}`, err);
        }
      })();
    }
    await this.connectPromise;
  }

  async get(phone: Phone): Promise<SessionState | null> {
    await this.ensureConnected();
    const key = this.sessionKey(phone);
    let raw: string | null;
    try {
      raw = await this.client.get(key);
    } catch (err) {
      throw new SessionStoreError(`Redis GET failed: ${(err as Error).message}`, err);
    }
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Session JSON parse failed; deleting corrupt entry');
      // Self-heal — best effort, ignore failures
      await this.client.del(key).catch(() => undefined);
      return null;
    }

    const result = SessionStateSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn({ issues: result.error.issues }, 'Session schema validation failed; deleting corrupt entry');
      await this.client.del(key).catch(() => undefined);
      return null;
    }
    return result.data;
  }

  async set(phone: Phone, state: SessionState): Promise<void> {
    await this.ensureConnected();

    const candidate: SessionState = { ...state, updatedAt: Date.now() };
    const result = SessionStateSchema.safeParse(candidate);
    if (!result.success) {
      throw new SessionStoreError(
        `Invalid session state: ${result.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const serialized = JSON.stringify(result.data);
    try {
      // EX = expire in N seconds; resets TTL on each set
      await this.client.set(this.sessionKey(phone), serialized, { EX: this.ttlSeconds });
    } catch (err) {
      throw new SessionStoreError(`Redis SET failed: ${(err as Error).message}`, err);
    }
  }

  async clear(phone: Phone): Promise<void> {
    await this.ensureConnected();
    try {
      await this.client.del(this.sessionKey(phone));
    } catch (err) {
      throw new SessionStoreError(`Redis DEL failed: ${(err as Error).message}`, err);
    }
  }

  async withLock<T>(phone: Phone, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
    await this.ensureConnected();
    const timeoutMs = opts.timeoutMs ?? 5000;
    const ttlMs = opts.ttlMs ?? 30000;
    if (ttlMs <= 0) throw new SessionStoreError(`Invalid lock ttlMs: ${ttlMs}`);
    if (timeoutMs <= 0) throw new SessionStoreError(`Invalid lock timeoutMs: ${timeoutMs}`);

    const key = this.lockKey(phone);
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;

    let acquired = false;
    while (Date.now() < deadline) {
      let result: string | null;
      try {
        // SET key token NX PX <ttl> — atomic acquire-if-absent with TTL
        result = await this.client.set(key, token, { NX: true, PX: ttlMs });
      } catch (err) {
        throw new SessionStoreError(`Redis SET NX failed: ${(err as Error).message}`, err);
      }
      if (result === 'OK') {
        acquired = true;
        break;
      }
      // Backoff: 25–75ms jitter. Short enough to feel responsive, jittered to
      // avoid thundering-herd retries when many waiters wake up at once.
      await sleep(25 + Math.random() * 50);
    }

    if (!acquired) {
      throw new LockTimeoutError(`Could not acquire session lock for ${phone} within ${timeoutMs}ms`);
    }

    try {
      return await fn();
    } finally {
      // Compare-and-delete: only release if our token is still the holder.
      // If our TTL already expired and another caller took the lock, this no-ops.
      try {
        await this.client.eval(RELEASE_LOCK_LUA, {
          keys: [key],
          arguments: [token],
        });
      } catch (err) {
        // Lock will expire naturally via PX — log and move on.
        logger.warn({ err: (err as Error).message }, 'Lock release failed; relying on TTL');
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client.isOpen) {
      try {
        await this.client.quit();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Redis quit() failed; forcing disconnect');
        try {
          await this.client.disconnect();
        } catch {
          // ignore — we're shutting down
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
