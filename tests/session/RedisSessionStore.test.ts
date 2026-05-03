import { describe, it } from 'vitest';
import { RedisSessionStore } from '../../src/session/RedisSessionStore';
import { runSessionStoreContractSuite } from './sessionStoreContract';

const REDIS_URL = process.env['REDIS_TEST_URL'];

if (REDIS_URL) {
  // Use a unique namespace per run to avoid cross-test pollution
  const namespace = `gridee-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  runSessionStoreContractSuite(
    'RedisSessionStore',
    ({ ttlMs }) =>
      new RedisSessionStore({
        url: REDIS_URL,
        ttlSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
        namespace,
      }),
  );
} else {
  // eslint-disable-next-line vitest/no-disabled-tests
  describe.skip('RedisSessionStore (skipped — set REDIS_TEST_URL to run)', () => {
    it('skipped', () => undefined);
  });
}
