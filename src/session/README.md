# Session Store — `gridee-bot/src/session`

Per-phone conversation state for the WhatsApp bot. Two implementations behind one
interface, swapped via env var.

## TL;DR

```typescript
import { SessionStoreFactory, Phone, newSessionState } from './session';
import { loadConfig } from './config';

const config = loadConfig();
const store = SessionStoreFactory.create({
  type: config.SESSION_STORE,           // 'memory' | 'redis'
  ttlSeconds: config.SESSION_TTL_SECONDS, // 1800 (30 min, per PRD)
  redisUrl: config.REDIS_URL,           // required iff type='redis'
});

const phone = Phone.of('+2348031234567');

await store.withLock(phone, async () => {
  const session = await store.get(phone) ?? newSessionState({ step: 'WELCOME_ROLE_SELECT' });
  // ...mutate...
  await store.set(phone, session);
});
```

## File map

| File | Purpose |
|---|---|
| `types.ts` | `Phone` brand, `ScreenId` enum (full SCREENS.md set), `SessionStep` enum (subset), `SessionState` schema |
| `ISessionStore.ts` | Interface contract — `get`, `set`, `clear`, `withLock`, `close` |
| `InMemorySessionStore.ts` | In-process Map implementation. Dev / test / single-process only. |
| `RedisSessionStore.ts` | Production implementation. Lazy connect, Lua-based safe lock release. |
| `SessionStoreFactory.ts` | One method, exhaustive switch. Single point of change. |
| `index.ts` | Public exports |

## Cost-aware defaults

`SESSION_STORE=memory` is the default. No Redis cost during local dev or unit
tests. Switch to `redis` for staging/prod by changing one env var — zero code
changes.

## Concurrency guarantees

- **Per-phone serialization**: `withLock(phone, fn)` guarantees no two `fn`s
  run concurrently for the same phone, even across processes (Redis impl).
- **Phone independence**: Locks for different phones never block each other.
- **Crash safety (Redis)**: Locks have their own TTL (default 30s). If the
  holder crashes, the lock is reclaimed by the next caller.
- **Lock release safety (Redis)**: Compare-and-delete via Lua — a lock holder
  whose TTL expired cannot accidentally release a *different* caller's lock.
- **Non-reentrant**: Calling `withLock(phone)` from inside another
  `withLock(phone)` for the same phone deadlocks. Don't do that. (Matches
  Redis SET NX semantics by design.)

## Schema enforcement

- `session.step` is typed as `SessionStep` — a Zod enum derived from
  `SESSION_STEPS` array. Typos like `'LANDLORD_REG_OPT'` won't compile.
- Every `set()` validates with Zod before writing.
- Every `get()` validates with Zod after reading. If validation fails (schema
  drift, manual edit in Redis), the entry is deleted and `null` is returned —
  the next `set()` writes fresh data.

## Tests

```bash
# Just the in-memory implementation (default — no Redis needed)
npx vitest run

# Include the Redis contract suite
REDIS_TEST_URL=redis://localhost:6379 npx vitest run
```

The same shared contract suite (`tests/session/sessionStoreContract.ts`) runs
against both implementations to prove behavioral parity. If a test passes for
in-memory but fails for Redis (or vice versa), the implementations are not
parity-compatible and the bug must be fixed before merging.

## Gotchas resolved

1. ✅ `session.step` typo bugs — caught at compile time via `SessionStep` enum
2. ✅ Stale data after schema changes — self-heals on read
3. ✅ Redis lock release deleting another caller's lock — Lua compare-and-delete
4. ✅ In-memory TTL timer leaks — tracked per entry, cleared on overwrite/delete
5. ✅ Concurrent webhooks for same phone — `withLock` serializes
6. ✅ In-memory deadlock if previous holder hangs — `LockTimeoutError`
7. ✅ TTL semantics drift between stores — both reset on `set()`, both expire on read
8. ✅ Process crash leaves Redis lock orphaned — independent lock TTL
9. ✅ Re-entrant lock attempts — explicitly non-reentrant; matches Redis
10. ✅ Behavioral parity — proven by shared test suite
