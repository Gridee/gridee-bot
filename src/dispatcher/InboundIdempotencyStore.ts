import { createClient, type RedisClientType } from 'redis';
import { ConfigError, GrideeError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Stores recently-seen inbound message IDs to detect duplicates.
 *
 * Providers retry webhook deliveries on non-2xx responses. Even with our
 * "always return 200" policy, brief connection blips at the LB layer can
 * cause the same message to arrive twice. Without idempotency, the user's
 * flow advances twice, OTP attempts get double-counted, payments may be
 * initiated twice, etc.
 *
 * Convention: key = `${provider}:${providerMessageId}`. Bool semantics:
 *   - markProcessed(key) returns true if this is the first time we've seen it
 *   - markProcessed(key) returns false if we've seen it before (skip)
 */
export interface IInboundIdempotencyStore {
  /**
   * Atomically check-and-set. Returns `true` if the key was newly inserted
   * (this is the first time we've seen this message), `false` if it was
   * already present (skip).
   */
  markProcessed(key: string): Promise<boolean>;

  /** Releases all resources. Idempotent. */
  close(): Promise<void>;
}

export class InboundIdempotencyError extends GrideeError {}

// ─────────────────────────────────────────────────────────────────────────────

export interface InMemoryIdempotencyOptions {
  /** TTL for entries, in milliseconds. Default 24h. */
  ttlMs?: number;
  /** Soft cap on entries before we force-prune. Default 50_000. */
  maxEntries?: number;
}

/**
 * In-memory idempotency store. Suitable only for single-process dev/test.
 * Multi-process deployments MUST use Redis — otherwise duplicate detection
 * is per-process and useless.
 */
export class InMemoryIdempotencyStore implements IInboundIdempotencyStore {
  private readonly seen = new Map<string, number>(); // key → expiresAt
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private closed = false;

  constructor(opts: InMemoryIdempotencyOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 50_000;
  }

  async markProcessed(key: string): Promise<boolean> {
    if (this.closed) throw new InboundIdempotencyError('Store closed');

    const now = Date.now();
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) {
      return false; // duplicate
    }

    if (this.seen.size >= this.maxEntries) {
      this.evictExpired(now);
      // If still over after eviction, drop the oldest 1% by scan order.
      // Crude but bounded — Redis is the production path.
      if (this.seen.size >= this.maxEntries) {
        const drop = Math.ceil(this.maxEntries * 0.01);
        let dropped = 0;
        for (const k of this.seen.keys()) {
          this.seen.delete(k);
          if (++dropped >= drop) break;
        }
      }
    }

    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.seen.clear();
  }

  private evictExpired(now: number): void {
    for (const [k, expiresAt] of this.seen.entries()) {
      if (expiresAt <= now) this.seen.delete(k);
    }
  }

  /** Test helper. */
  size(): number {
    return this.seen.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface RedisIdempotencyOptions {
  url: string;
  /** TTL in seconds. Default 86400 (24h). */
  ttlSeconds?: number;
  /** Key namespace. Default 'gridee:inbound'. */
  namespace?: string;
}

/**
 * Redis-backed idempotency store using SET NX with TTL.
 * Multi-process safe.
 */
export class RedisIdempotencyStore implements IInboundIdempotencyStore {
  private readonly client: RedisClientType;
  private readonly ttlSeconds: number;
  private readonly namespace: string;
  private connectPromise: Promise<void> | null = null;
  private closed = false;

  constructor(opts: RedisIdempotencyOptions) {
    if (!opts.url) throw new InboundIdempotencyError('Redis URL required');
    this.ttlSeconds = opts.ttlSeconds ?? 24 * 60 * 60;
    this.namespace = opts.namespace ?? 'gridee:inbound';
    this.client = createClient({ url: opts.url });
    this.client.on('error', (err: Error) => {
      logger.error({ err: err.message }, 'Redis idempotency client error');
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new InboundIdempotencyError('Store closed');
    if (this.client.isOpen) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        try {
          await this.client.connect();
        } catch (err) {
          this.connectPromise = null;
          throw new InboundIdempotencyError(
            `Redis connection failed: ${(err as Error).message}`,
            err,
          );
        }
      })();
    }
    await this.connectPromise;
  }

  async markProcessed(key: string): Promise<boolean> {
    await this.ensureConnected();
    const fullKey = `${this.namespace}:${key}`;
    try {
      // SET key 1 NX EX <ttl> — atomic insert-if-absent with TTL
      const result = await this.client.set(fullKey, '1', {
        NX: true,
        EX: this.ttlSeconds,
      });
      return result === 'OK';
    } catch (err) {
      throw new InboundIdempotencyError(
        `Redis SET NX failed: ${(err as Error).message}`,
        err,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client.isOpen) {
      try {
        await this.client.quit();
      } catch {
        try {
          await this.client.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export type IdempotencyStoreType = 'memory' | 'redis';

export interface IdempotencyStoreFactoryConfig {
  type: IdempotencyStoreType;
  ttlSeconds?: number;
  redisUrl?: string;
  redisNamespace?: string;
}

export class IdempotencyStoreFactory {
  static create(config: IdempotencyStoreFactoryConfig): IInboundIdempotencyStore {
    switch (config.type) {
      case 'memory': {
        const opts: InMemoryIdempotencyOptions = {};
        if (config.ttlSeconds !== undefined) opts.ttlMs = config.ttlSeconds * 1000;
        return new InMemoryIdempotencyStore(opts);
      }
      case 'redis': {
        if (!config.redisUrl) {
          throw new ConfigError("redisUrl is required when idempotency type='redis'");
        }
        const opts: RedisIdempotencyOptions = { url: config.redisUrl };
        if (config.ttlSeconds !== undefined) opts.ttlSeconds = config.ttlSeconds;
        if (config.redisNamespace !== undefined) opts.namespace = config.redisNamespace;
        return new RedisIdempotencyStore(opts);
      }
      default: {
        const _exhaustive: never = config.type;
        throw new ConfigError(`Unknown idempotency store type: ${String(_exhaustive)}`);
      }
    }
  }
}
