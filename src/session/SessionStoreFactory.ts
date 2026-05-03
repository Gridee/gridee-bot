import { ConfigError } from '../lib/errors';
import type { ISessionStore } from './ISessionStore';
import { InMemorySessionStore } from './InMemorySessionStore';
import { RedisSessionStore } from './RedisSessionStore';

export type SessionStoreType = 'memory' | 'redis';

export interface SessionStoreFactoryConfig {
  /** Which implementation to instantiate. Driven by env in production. */
  type: SessionStoreType;
  /** Session TTL in seconds. PRD says 30 minutes → 1800. */
  ttlSeconds: number;
  /** Redis connection URL. Required iff `type === 'redis'`. */
  redisUrl?: string;
  /** Optional Redis key namespace (e.g. 'gridee:dev'). */
  redisNamespace?: string;
}

/**
 * Factory for session stores.
 *
 * The pattern is intentionally simple: one method, exhaustive switch, no
 * registry overhead. We never need to add a third implementation at runtime —
 * if we do, this file is the single place to add it.
 *
 * Usage:
 *   const store = SessionStoreFactory.create({
 *     type: config.SESSION_STORE,
 *     ttlSeconds: config.SESSION_TTL_SECONDS,
 *     redisUrl: config.REDIS_URL,
 *   });
 */
export class SessionStoreFactory {
  static create(config: SessionStoreFactoryConfig): ISessionStore {
    switch (config.type) {
      case 'memory':
        return new InMemorySessionStore({ ttlMs: config.ttlSeconds * 1000 });

      case 'redis': {
        if (!config.redisUrl) {
          throw new ConfigError("redisUrl is required when SESSION_STORE='redis'");
        }
        const opts: ConstructorParameters<typeof RedisSessionStore>[0] = {
          url: config.redisUrl,
          ttlSeconds: config.ttlSeconds,
        };
        if (config.redisNamespace !== undefined) opts.namespace = config.redisNamespace;
        return new RedisSessionStore(opts);
      }

      default: {
        // Exhaustiveness check — adding a new SessionStoreType without handling
        // it here will cause a compile error.
        const _exhaustive: never = config.type;
        throw new ConfigError(`Unknown session store type: ${String(_exhaustive)}`);
      }
    }
  }
}
