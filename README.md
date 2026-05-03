# gridee-bot

WhatsApp bot for Gridee — owned by you (Izzy). Receives inbound messages, manages per-phone session state, drives multi-step flows (landlord onboarding, tenant onboarding, BUY), and forwards command requests to the backend.

## Quick start

Requires **Node 20.12+** (or Node 22+) for the built-in `--env-file-if-exists` flag.

```bash
npm install
cp .env.example .env
# Fill in TWILIO_* (sandbox values are fine to start)

npm run typecheck    # strict TS check
npm test             # run all tests (no Redis needed by default)

npm run dev          # start with auto-reload (tsx watch); .env auto-loaded
npm run build        # compile to dist/
npm start            # run compiled output; .env auto-loaded

# To also run the Redis contract suite:
REDIS_TEST_URL=redis://localhost:6379 npm test
```

After `npm run dev`, the bot listens on `PORT` (default 3001). Point your messaging provider's webhook at:
- `GET  https://your-host/webhook` (Meta WhatsApp Cloud verification handshake)
- `POST https://your-host/webhook` (inbound messages — Twilio, Meta, or Africa's Talking)

### Twilio WhatsApp sandbox — local dev

The sandbox needs a public HTTPS URL. Use ngrok (or any tunnel):

```bash
# Terminal 1 — bot
npm run dev   # listens on :3001

# Terminal 2 — public tunnel
ngrok http 3001
# Copy the https://xxx.ngrok-free.app URL it prints
```

Then in **Twilio Console → Messaging → Try it out → Send a WhatsApp message → Sandbox settings**:
- **When a message comes in**: `https://xxx.ngrok-free.app/webhook`  (POST)

And in your `.env`:
```
TWILIO_PUBLIC_WEBHOOK_URL=https://xxx.ngrok-free.app/webhook
```

> **Critical**: `TWILIO_PUBLIC_WEBHOOK_URL` must EXACTLY match the URL Twilio is configured to call. The provider verifies signatures using this URL; any mismatch (path, scheme, trailing slash) and signature verification fails with a 401. ngrok URLs change each restart unless you use a paid static domain — update the env file each time.

### Per-provider webhook paths

If you want Twilio to POST to a sub-path (e.g. so a single host can serve multiple providers):

```bash
WEBHOOK_PATH=/webhook/twilio
TWILIO_PUBLIC_WEBHOOK_URL=https://xxx.ngrok-free.app/webhook/twilio
```

Config validates that the URL path matches `WEBHOOK_PATH` and refuses to start the bot if they disagree — this catches the most common Twilio sandbox setup mistake before it produces 401s.

To send your sandbox the join code (one-time), text "join <code>" to `+1 415 523 8886` from the WhatsApp number you want to test with. The code is on the same Twilio sandbox page.

## Status

| Module | Status |
|---|---|
| `src/lib/` | ✅ Done — errors, logger, phone (branded), safeMessage |
| `src/config/` | ✅ Done — env validation |
| `src/session/` | ✅ Done — factory + InMemory + Redis stores, locking, TTL |
| `src/messaging/` | ✅ Done — factory + Twilio/WhatsApp Cloud/AT providers |
| `src/client/` | ✅ Done — typed HTTP client with Zod-validated contracts |
| `src/templates/` | ✅ Done (default impl) — Mark replaces with prod copy |
| `src/flows/` | ✅ Done — Role selection, Landlord/Tenant onboarding, BUY |
| `src/dispatcher/` | ✅ Done — orchestrates inbound → flow → reply, idempotency, locking |
| `src/handlers/` | ✅ Done — Express webhook handlers (challenge + inbound) |
| `src/middleware/` | ✅ Done — request logger, error handler, healthcheck |
| `src/routes/` | ✅ Done — wires handlers to paths |
| `src/server.ts` | ✅ Done — bootstrap + graceful shutdown |
| `src/commands/` | ⬜ To build — BALANCE, HELP, MY_PROPERTIES, etc. (post-auth idle commands) |

## Folder layout

```
gridee-bot/
├── src/
│   ├── config/                 Env loading (Zod)
│   ├── lib/                    errors, logger, phone, safeMessage
│   ├── session/                Factory + InMemory + Redis stores
│   ├── messaging/              Factory + 3 providers (Twilio, WA Cloud, AT)
│   ├── client/                 (next) typed HTTP → backend
│   ├── flows/                  (next) state machines
│   ├── commands/               (next) single-shot commands
│   ├── dispatcher/             (next) routes msg → flow/command
│   ├── handlers/               (next) Express webhook handler
│   ├── middleware/             (next) signature verify, idempotency
│   └── server.ts               (next) Express bootstrap
└── tests/
    ├── lib/
    ├── messaging/
    └── session/                Includes a SHARED contract suite that runs
                                against both InMemory and Redis stores
```

## Key design decisions

1. **Provider factories everywhere** — `MessagingProviderFactory`, `SessionStoreFactory`. One env var swaps the implementation. New providers slot in via exhaustive switch.
2. **Branded `Phone` type** — phone-number arguments cannot be confused with raw strings. Validates E.164 at the boundary.
3. **`ScreenId` enum** — typo-proof matching to SCREENS.md. Session step is typed as a subset of screen IDs.
4. **`safeMessage()` at the sender boundary** — every outbound message goes through this internally. Cannot be forgotten.
5. **`withLock(phone, fn)` for session mutations** — serializes concurrent webhook deliveries for the same phone. Lua-based safe release on Redis.
6. **Strict TypeScript** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc. Bug classes that aren't physically possible in this codebase.

## How sessions work

Per-phone state stored in a key-value store. Two implementations, one interface:

```typescript
import { SessionStoreFactory, Phone, newSessionState } from './session';

const store = SessionStoreFactory.create({
  type: config.SESSION_STORE,            // 'memory' (default) or 'redis'
  ttlSeconds: config.SESSION_TTL_SECONDS,
  redisUrl: config.REDIS_URL,
});

const phone = Phone.of('+2348031234567');

await store.withLock(phone, async () => {
  const session = await store.get(phone) ?? newSessionState({ step: 'WELCOME_ROLE_SELECT' });
  // ...mutate based on incoming message...
  await store.set(phone, session);
});
```

`SESSION_STORE=memory` is free and fast — use during development. Switch to `redis` for prod with one env var, no code changes. See `src/session/README.md` for full details.

## How messaging works

```typescript
import { MessagingProviderFactory } from './messaging';

const provider = MessagingProviderFactory.create({
  type: config.MESSAGING_PROVIDER,        // 'twilio' (test) | 'whatsapp_cloud' (prod) | 'africas_talking'
  twilioAccountSid: config.TWILIO_ACCOUNT_SID,
  twilioAuthToken: config.TWILIO_AUTH_TOKEN,
  twilioWhatsappFrom: config.TWILIO_WHATSAPP_FROM,
  twilioPublicWebhookUrl: config.TWILIO_PUBLIC_WEBHOOK_URL,  // ⚠ needed for sig verify
});

// Inbound webhook handler (one shape for any provider)
app.all('/webhook', (req, res) => {
  const challenge = provider.verifyChallenge(req);
  if (challenge !== null) return res.send(challenge);

  if (!provider.verifySignature(req, req.rawBody)) {
    return res.status(401).end();
  }

  const inbound = provider.parseInbound(req.rawBody, req.headers['content-type']);
  if (inbound === null) return res.status(200).end();  // status callback

  // ...dispatch to flow/command...
  return res.status(200).end();
});

// Outbound (any provider, same call)
await provider.sendMessage({ to: phone, text: 'Hello!', screenId: 'WELCOME_ROLE_SELECT' });
```

## What you do NOT need from the backend

- DB access, repositories
- HAL / consumption engine / cron jobs
- Payment webhook handling

The bot only talks to the backend over HTTP, via a typed `BackendClient` (next module to build).

## Next steps in this repo

1. **`client/BackendClient.ts`** — typed HTTP client with Zod-validated request/response schemas, one method per backend API endpoint
2. **`flows/`** — `LandlordOnboardingFlow` (chained through ADD_PROPERTY per SCREENS.md), `TenantOnboardingFlow`, `BuyFlow`
3. **`commands/`** — single-shot handlers for `BALANCE`, `HISTORY`, `HELP`, `MY_PROPERTIES`, `EARNINGS`, `WITHDRAW`, `TENANTS`, `REMOVE TENANT`
4. **`dispatcher/MessageDispatcher`** — uses `withLock` per inbound message, routes based on session step + message text
5. **`handlers/webhookHandler.ts` + `routes/`** — Express endpoints
6. **Manual end-to-end test** — your task list's last step
