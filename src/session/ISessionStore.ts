import type { Phone, SessionState } from './types';

/**
 * Options controlling lock behavior for `withLock`.
 *
 * - `timeoutMs`: how long the *caller* waits to acquire the lock before giving up.
 *                Default 5000ms. Throws `LockTimeoutError` on expiry.
 *
 * - `ttlMs`:     how long the lock itself is valid once held. Prevents permanently
 *                stuck locks across process crashes (Redis only — in-memory ignores
 *                this since a crash kills everything anyway).
 *                Default 30000ms.
 *
 * Set `ttlMs` higher than the longest expected `fn` runtime, and `timeoutMs`
 * higher than `ttlMs` only if you want callers to wait through a full lock TTL.
 */
export interface LockOptions {
  timeoutMs?: number;
  ttlMs?: number;
}

/**
 * Per-phone session storage.
 *
 * The store is opaque about phone format — it stores whatever string key it
 * receives. Phone normalization (E.164) happens upstream in the dispatcher.
 *
 * IMPORTANT: `withLock` is NOT re-entrant. Calling `withLock(phone, ...)` from
 * inside a `withLock(phone, ...)` callback for the same phone will deadlock.
 * This matches the semantics of Redis SET NX. For nested operations, pass the
 * already-locked context down or refactor to flatten.
 */
export interface ISessionStore {
  /**
   * Returns the session for a phone, or null if absent or expired.
   * If stored data fails schema validation, the store self-heals by deleting
   * the corrupt entry and returning null.
   */
  get(phone: Phone): Promise<SessionState | null>;

  /**
   * Upserts the session for a phone. Resets the TTL to the configured value.
   * `updatedAt` is overwritten to `Date.now()` regardless of the input value.
   * Throws `SessionStoreError` on validation failure.
   */
  set(phone: Phone, state: SessionState): Promise<void>;

  /**
   * Deletes the session for a phone. Idempotent — no error if absent.
   */
  clear(phone: Phone): Promise<void>;

  /**
   * Acquires an exclusive lock for `phone`, runs `fn`, then releases the lock —
   * even if `fn` throws. The lock guarantees no other `withLock` call for the
   * same phone runs concurrently in this store, across all processes (Redis)
   * or within this process (in-memory).
   *
   * Throws `LockTimeoutError` if the lock cannot be acquired within `timeoutMs`.
   */
  withLock<T>(phone: Phone, fn: () => Promise<T>, opts?: LockOptions): Promise<T>;

  /**
   * Releases all resources. After calling close(), the store must not be used.
   * Idempotent.
   */
  close(): Promise<void>;
}
