# Dispatcher (`gridee-bot/src/dispatcher/`)

The "wiring" layer. Owns the full lifecycle of an inbound message, from idempotency check to flow execution to outbound reply.

## Files

| File | Role |
|---|---|
| `MessageDispatcher.ts` | Orchestrates inbound → flow → reply → save |
| `applySessionPatch.ts` | Pure function: merges a `SessionPatch` into a `SessionState` |
| `InboundIdempotencyStore.ts` | Interface + in-memory + Redis impls + factory for duplicate detection |
| `index.ts` | Public exports |

## Lifecycle of one inbound message

```
1. Idempotency check
   └── Have we seen this providerMessageId before? → skip, return 'duplicate'

2. Acquire per-phone lock (Redis SET NX in prod; in-memory mutex in dev)
   └── Serializes concurrent webhooks for the same phone

3. Load session
   └── If null → initialize at WELCOME_ROLE_SELECT (mark dispatcher-dirty)

4. Pre-flow command interception
   └── "BUY <amount>" from authenticated tenant
       → seed session.data, set step = BUY_CONFIRM (mark dirty)
   └── "BUY" alone from authenticated tenant
       → set step = BUY_AMOUNT (mark dirty)

5. Find flow for current step
   └── If null (idle authenticated) → send nudge

6. flow.handle(ctx, message) → FlowResult

7. Apply FlowResult:
   ┌──────────────────────────────────────────────────────────────────┐
   │ kind         │ Order              │ Outcome                       │
   ├──────────────┼────────────────────┼───────────────────────────────┤
   │ advance      │ send → save        │ Step changes; data updated    │
   │ complete     │ send → save        │ Terminal step (e.g. AUTH'd)   │
   │ stay+patch   │ send → save        │ Same step; data tweaked       │
   │ stay (dirty) │ send → save        │ Persists pre-flow patch       │
   │ reset        │ send → clear       │ Session deleted; restart      │
   │ passthrough  │ send nudge         │ No flow change                │
   └──────────────────────────────────────────────────────────────────┘

8. Release lock, return DispatchOutcome
```

## Critical ordering: send first, save second

If a `sendMessage` fails AFTER saving the session, the user sees an old screen but is on a new step. Their next message gets routed wrong.

So the dispatcher always sends first. If send fails, session is not advanced — user retries from the same step. Caveat: `reset` clears the session even if send fails, because that user is already in a bad state and we want them recoverable.

## Why `dispatcherDirty` exists

When the dispatcher itself modifies the session (new init, BUY shortcut), then the flow returns `stay` with no patch, the session changes would otherwise be discarded. The dirty flag persists those changes anyway. Two real bugs the test suite caught:

1. New phone sends "hi" → session was initialized in memory but never saved → next message also created a fresh session
2. Tenant sends "BUY 5000" → shortcut moved to BUY_CONFIRM but flow couldn't parse "BUY 5000" as a method → no save → next "1" message saw step=TENANT_AUTHENTICATED

## Idempotency store

Same factory pattern as the session store. `memory` for dev/tests, `redis` for prod. The Redis impl uses `SET NX EX` for atomic insert-with-TTL — one round-trip, multi-process safe.

If the idempotency check itself throws (Redis blip), the dispatcher logs and processes the message anyway. We'd rather occasionally double-process than drop a user's message.

## Concurrency

Per-phone lock + per-message idempotency together give us:
- Two webhooks for the SAME message ID → one processed (idempotency)
- Two webhooks for DIFFERENT messages from same phone → serialized in arrival order (lock)
- Two webhooks for different phones → run in parallel

The `lockTimeoutMs` (default 20s) bounds how long the second webhook waits before giving up. Should be greater than the longest expected backend call (BackendClient default timeout is 10s).

## Test coverage

51 tests covering:
- Idempotency store (in-memory + factory)
- `applySessionPatch` (12 cases incl. clearData, jwtClear, mutation safety)
- All 5 FlowResult kinds
- Send-first/save-second ordering on send failure
- Per-phone serialization
- BUY shortcut interception (4 scenarios)
- New-phone init persistence
- Flow-throws recovery
- End-to-end landlord onboarding (7 messages → LANDLORD_AUTHENTICATED)
