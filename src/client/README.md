# Backend Client (`gridee-bot/src/client/`)

Typed HTTP client for talking to `gridee-backend`. All flows and commands import from here — no raw `axios`/`fetch` calls anywhere else in the bot.

## Quick start

```typescript
import { BackendClient } from './client';
import { loadConfig } from './config';

const config = loadConfig();
const client = new BackendClient({
  baseUrl: config.BACKEND_API_URL,
  timeoutMs: config.BACKEND_API_TIMEOUT_MS,
});

// Every method returns Result<T, BackendError> — never throws.
const result = await client.registerLandlord({
  fullName: 'Lola Adeyemi',
  phone: '+2348031234567',
});

if (!result.ok) {
  // result.error is one of:
  //   BackendApiError       — backend returned a 4xx/5xx envelope
  //   BackendAuthError      — 401 specifically (clear JWT)
  //   BackendNetworkError   — timeout, DNS, network
  //   BackendContractError  — request or response failed schema validation
  return handleError(result.error);
}

// result.value is fully typed
const { otpRef, expiresAt } = result.value;
```

## File map

| File | Role |
|---|---|
| `contracts.ts` | All Zod schemas and types. **Mirrored** to `gridee-backend/src/contracts/index.ts`. |
| `errors.ts` | `BackendError` hierarchy + `Result<T, E>` |
| `HttpTransport.ts` | Low-level: timeout, retry, idempotency, JSON parse, error envelope decoding |
| `BackendClient.ts` | One method per endpoint. Each: validates request → calls transport → validates response. |
| `index.ts` | Public exports |

## Design choices

### 1. `Result<T, E>` instead of throwing

Methods never throw to the caller. The flow / dispatcher code can pattern-match cleanly without try/catch noise:

```typescript
const result = await client.verifyOtp({ otpRef, otp });
if (!result.ok) {
  if (result.error instanceof BackendApiError && result.error.code === 'INVALID_OTP') {
    await sender.sendMessage({ to: phone, text: templates.errorInvalidOtp() });
    return; // stay on same step
  }
  // ... handle other error classes ...
}
```

### 2. Schemas are Zod, types are inferred

No hand-written interfaces. The schema IS the type:

```typescript
export const RegisterLandlordRequestSchema = z.object({...});
export type RegisterLandlordRequest = z.infer<typeof RegisterLandlordRequestSchema>;
```

Editing the schema automatically updates the type. Drift is impossible.

### 3. Validate request AND response

Most clients only validate responses. We also validate requests so bot bugs (a flow building a malformed payload) surface immediately with the field name, instead of as an opaque 400 from the backend.

### 4. Idempotency keys on every POST

Every POST gets an `Idempotency-Key` header (auto-generated UUID v4 if not supplied). Crucially, **the same key is reused across retries** — otherwise idempotency on the backend is useless.

When the bot starts a payment in response to a webhook that might be redelivered, callers should pass a stable `idempotencyKey` derived from the inbound message ID. The transport already handles the auto-generated case for the simpler scenarios.

> Note: the public `BackendClient` methods don't currently expose `idempotencyKey` — the auto-generated UUID is fine for all current flows because the dispatcher's per-phone Redis lock prevents concurrent flow advances. Add a parameter when the first flow needs a stable key.

### 5. Retry on 5xx and network errors only

4xx is never retried — those are deterministic. The retry loop uses exponential backoff with jitter (default: 200ms, 400ms, 800ms…).

### 6. 401 → `BackendAuthError`

A separate subclass so the dispatcher can react specifically: clear `session.jwt`, send a re-auth prompt, etc., without checking the HTTP status manually.

## Adding a new endpoint

1. Add the request and response Zod schemas to `contracts.ts`
2. **Copy `contracts.ts` to `gridee-backend/src/contracts/index.ts`**
3. Add a method to `BackendClient.ts` using `callAuthed` or `callPublic`
4. Add a test in `tests/client/BackendClient.test.ts`

That's it. No interface drift possible.

## Test coverage

```bash
npm test -- client
```

29 tests covering:
- Request validation (rejects bad input before sending)
- Response validation (catches contract drift)
- Auth header attachment
- Idempotency key generation + retry stability
- Retry on 5xx, no retry on 4xx
- 401 → `BackendAuthError`
- Timeout → `BackendNetworkError`
- Standard error envelope parsing
