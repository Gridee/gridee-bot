import { describe, expect, it } from 'vitest';
import {
  IdempotencyStoreFactory,
  InMemoryIdempotencyStore,
} from '../../src/dispatcher/InboundIdempotencyStore';
import { ConfigError } from '../../src/lib/errors';

describe('InMemoryIdempotencyStore', () => {
  it('returns true for first markProcessed and false for duplicates', async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.markProcessed('twilio:abc')).toBe(true);
    expect(await store.markProcessed('twilio:abc')).toBe(false);
    expect(await store.markProcessed('twilio:abc')).toBe(false);
    await store.close();
  });

  it('isolates keys by provider', async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.markProcessed('twilio:abc')).toBe(true);
    expect(await store.markProcessed('whatsapp_cloud:abc')).toBe(true);
    await store.close();
  });

  it('expires entries after TTL', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 50 });
    expect(await store.markProcessed('k')).toBe(true);
    expect(await store.markProcessed('k')).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    // After TTL, the key is treated as new
    expect(await store.markProcessed('k')).toBe(true);
    await store.close();
  });

  it('enforces maxEntries by evicting expired then dropping oldest', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 60_000, maxEntries: 100 });
    for (let i = 0; i < 100; i++) {
      await store.markProcessed(`k${i}`);
    }
    expect(store.size()).toBe(100);
    // Adding one more triggers eviction
    await store.markProcessed('overflow');
    expect(store.size()).toBeLessThanOrEqual(100);
    await store.close();
  });

  it('throws after close', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.close();
    await expect(store.markProcessed('k')).rejects.toThrow();
  });
});

describe('IdempotencyStoreFactory', () => {
  it('builds memory store', () => {
    const store = IdempotencyStoreFactory.create({ type: 'memory' });
    expect(store).toBeInstanceOf(InMemoryIdempotencyStore);
  });

  it('throws when redis is selected without URL', () => {
    expect(() => IdempotencyStoreFactory.create({ type: 'redis' })).toThrow(ConfigError);
  });

  it('throws on unknown type', () => {
    expect(() =>
      IdempotencyStoreFactory.create({ type: 'foo' as never }),
    ).toThrow(ConfigError);
  });
});
