import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/lib/errors';
import { SessionStoreFactory } from '../../src/session/SessionStoreFactory';
import { InMemorySessionStore } from '../../src/session/InMemorySessionStore';
import { RedisSessionStore } from '../../src/session/RedisSessionStore';

describe('SessionStoreFactory', () => {
  it('returns InMemorySessionStore for type=memory', () => {
    const store = SessionStoreFactory.create({ type: 'memory', ttlSeconds: 60 });
    expect(store).toBeInstanceOf(InMemorySessionStore);
  });

  it('returns RedisSessionStore for type=redis with URL', () => {
    const store = SessionStoreFactory.create({
      type: 'redis',
      ttlSeconds: 60,
      redisUrl: 'redis://localhost:6379',
    });
    expect(store).toBeInstanceOf(RedisSessionStore);
  });

  it('throws ConfigError when type=redis but no URL is provided', () => {
    expect(() =>
      SessionStoreFactory.create({ type: 'redis', ttlSeconds: 60 }),
    ).toThrow(ConfigError);
  });

  it('throws on unknown type at runtime (defensive)', () => {
    expect(() =>
      SessionStoreFactory.create({
        type: 'bogus' as never,
        ttlSeconds: 60,
      }),
    ).toThrow(ConfigError);
  });
});
