import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ISessionStore } from '../../src/session/ISessionStore';
import { LockTimeoutError, SessionStoreError } from '../../src/lib/errors';
import { Phone, type SessionState, newSessionState } from '../../src/session/types';

const PHONE_A: Phone = Phone.of('+2348031234567');
const PHONE_B: Phone = Phone.of('+2348031111111');

/**
 * Shared behavioral suite. Pass a factory that returns a fresh store with the
 * given TTL; the suite handles setup/teardown.
 *
 * Every implementation of ISessionStore MUST pass this suite to be considered
 * a correct implementation.
 */
export function runSessionStoreContractSuite(
  name: string,
  makeStore: (opts: { ttlMs: number }) => ISessionStore,
): void {
  describe(`ISessionStore contract: ${name}`, () => {
    let store: ISessionStore;

    beforeEach(() => {
      store = makeStore({ ttlMs: 60_000 });
    });

    afterEach(async () => {
      await store.close();
    });

    function makeState(stepOverrides?: Partial<SessionState>): SessionState {
      const base = newSessionState({ step: 'WELCOME_ROLE_SELECT' });
      return { ...base, ...stepOverrides };
    }

    // ─── Basic CRUD ───────────────────────────────────────────────────────

    it('returns null for absent phone', async () => {
      expect(await store.get(PHONE_A)).toBeNull();
    });

    it('round-trips a session through set → get', async () => {
      const state = makeState({ role: 'landlord', step: 'LANDLORD_REG_NAME', data: { hello: 'world' } });
      await store.set(PHONE_A, state);
      const got = await store.get(PHONE_A);
      expect(got).not.toBeNull();
      expect(got!.step).toBe('LANDLORD_REG_NAME');
      expect(got!.role).toBe('landlord');
      expect(got!.data).toEqual({ hello: 'world' });
    });

    it('overwrites updatedAt on every set, regardless of input value', async () => {
      const fakeOld = makeState({ updatedAt: 0 });
      await store.set(PHONE_A, fakeOld);
      const got = await store.get(PHONE_A);
      expect(got!.updatedAt).toBeGreaterThan(0);
      // updatedAt should be very recent (within last 5s)
      expect(Date.now() - got!.updatedAt).toBeLessThan(5_000);
    });

    it('isolates sessions per phone', async () => {
      const stateA = makeState({ step: 'LANDLORD_REG_NAME', role: 'landlord' });
      const stateB = makeState({ step: 'TENANT_REG_NAME', role: 'tenant' });
      await store.set(PHONE_A, stateA);
      await store.set(PHONE_B, stateB);
      const a = await store.get(PHONE_A);
      const b = await store.get(PHONE_B);
      expect(a!.role).toBe('landlord');
      expect(b!.role).toBe('tenant');
    });

    it('clear() deletes the session and is idempotent', async () => {
      await store.set(PHONE_A, makeState());
      await store.clear(PHONE_A);
      expect(await store.get(PHONE_A)).toBeNull();
      // Second clear should not throw
      await store.clear(PHONE_A);
      expect(await store.get(PHONE_A)).toBeNull();
    });

    // ─── Validation ───────────────────────────────────────────────────────

    it('rejects invalid step values on set', async () => {
      const bad = { ...makeState(), step: 'NOT_A_REAL_STEP' as never };
      await expect(store.set(PHONE_A, bad)).rejects.toBeInstanceOf(SessionStoreError);
    });

    it('rejects invalid role on set', async () => {
      const bad = { ...makeState(), role: 'admin' as never };
      await expect(store.set(PHONE_A, bad)).rejects.toBeInstanceOf(SessionStoreError);
    });

    it('rejects negative timestamps on set', async () => {
      const bad = { ...makeState(), createdAt: -1 };
      await expect(store.set(PHONE_A, bad)).rejects.toBeInstanceOf(SessionStoreError);
    });

    // ─── TTL ──────────────────────────────────────────────────────────────

    it('expires sessions after TTL', async () => {
      const shortStore = makeStore({ ttlMs: 100 });
      try {
        await shortStore.set(PHONE_A, makeState());
        await sleep(200);
        expect(await shortStore.get(PHONE_A)).toBeNull();
      } finally {
        await shortStore.close();
      }
    });

    it('resets TTL on every set', async () => {
      const shortStore = makeStore({ ttlMs: 200 });
      try {
        await shortStore.set(PHONE_A, makeState());
        await sleep(120);
        // Re-set before original TTL elapses → should reset to fresh 200ms
        await shortStore.set(PHONE_A, makeState({ step: 'LANDLORD_REG_NAME' }));
        await sleep(120);
        // Total elapsed: 240ms, but TTL was reset 120ms ago → still alive
        const got = await shortStore.get(PHONE_A);
        expect(got).not.toBeNull();
        expect(got!.step).toBe('LANDLORD_REG_NAME');
      } finally {
        await shortStore.close();
      }
    });

    // ─── Locking ──────────────────────────────────────────────────────────

    it('serializes withLock calls for the same phone', async () => {
      const order: string[] = [];
      const tasks = [1, 2, 3].map((n) =>
        store.withLock(PHONE_A, async () => {
          order.push(`start-${n}`);
          await sleep(20);
          order.push(`end-${n}`);
          return n;
        }),
      );
      const results = await Promise.all(tasks);
      expect(results).toEqual([1, 2, 3]);
      // Each "start-N" must be immediately followed by "end-N" — never interleaved
      expect(order).toEqual([
        'start-1', 'end-1',
        'start-2', 'end-2',
        'start-3', 'end-3',
      ]);
    });

    it('does NOT serialize withLock calls for different phones', async () => {
      const order: string[] = [];
      const release = makeManualPromise<void>();
      const taskA = store.withLock(PHONE_A, async () => {
        order.push('A-start');
        await release.promise;
        order.push('A-end');
      });
      // Yield so taskA can grab the lock
      await sleep(10);
      const taskB = store.withLock(PHONE_B, async () => {
        order.push('B-start');
        order.push('B-end');
      });
      await taskB; // B should run independently of A
      release.resolve();
      await taskA;
      expect(order).toEqual(['A-start', 'B-start', 'B-end', 'A-end']);
    });

    it('returns the value from fn', async () => {
      const result = await store.withLock(PHONE_A, async () => 'hello');
      expect(result).toBe('hello');
    });

    it('releases the lock if fn throws', async () => {
      await expect(
        store.withLock(PHONE_A, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      // Next acquisition must not hang
      const result = await store.withLock(PHONE_A, async () => 42, { timeoutMs: 500 });
      expect(result).toBe(42);
    });

    it('throws LockTimeoutError if lock cannot be acquired in time', async () => {
      const release = makeManualPromise<void>();
      const holder = store.withLock(PHONE_A, async () => {
        await release.promise;
      });
      // Yield so holder grabs lock
      await sleep(10);
      await expect(
        store.withLock(PHONE_A, async () => 'never', { timeoutMs: 100 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
      release.resolve();
      await holder;
    });

    it('a timed-out waiter does not block subsequent waiters', async () => {
      const release = makeManualPromise<void>();
      const holder = store.withLock(PHONE_A, async () => {
        await release.promise;
      });
      await sleep(10);

      // First waiter times out
      const timedOut = store.withLock(PHONE_A, async () => 'first', { timeoutMs: 100 });
      await expect(timedOut).rejects.toBeInstanceOf(LockTimeoutError);

      // Release the holder; a new waiter should acquire cleanly
      release.resolve();
      await holder;

      const result = await store.withLock(PHONE_A, async () => 'second', { timeoutMs: 1_000 });
      expect(result).toBe('second');
    });

    // ─── Lifecycle ────────────────────────────────────────────────────────

    it('throws after close()', async () => {
      await store.close();
      await expect(store.get(PHONE_A)).rejects.toBeInstanceOf(SessionStoreError);
      await expect(store.set(PHONE_A, makeState())).rejects.toBeInstanceOf(SessionStoreError);
    });

    it('close() is idempotent', async () => {
      await store.close();
      await expect(store.close()).resolves.toBeUndefined();
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeManualPromise<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
