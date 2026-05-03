# Handlers, Routes, Middleware, Server

The Express layer that wires the dispatcher to HTTP.

## File map

```
src/handlers/    webhookHandler.ts   GET /webhook (challenge) + POST /webhook (inbound)
src/middleware/  index.ts            requestLogger, errorHandler, healthCheck
src/routes/      index.ts            Combines handlers into a Router
src/server.ts    Bootstrap — wires every module, exports buildApp() + startServer()
```

## How the webhook route works

```
                   ┌────────────────────────────┐
   Provider POST   │ POST /webhook              │
        ──────────▶│   express.raw({ limit })   │  ← raw bytes, NOT json()
                   │       │                    │
                   │       ▼                    │
                   │   webhookHandler.inbound   │
                   │   ┌──────────────────────┐ │
                   │   │ 1. parse form/json   │ │
                   │   │ 2. verifySignature   │ │  → 401 if invalid
                   │   │ 3. parseInbound      │ │  → 200 if status callback
                   │   │ 4. dispatcher.dispatch│ │  → never throws
                   │   │ 5. ALWAYS 200        │ │
                   │   └──────────────────────┘ │
                   └────────────────────────────┘
```

### Why `express.raw()` is route-scoped

Twilio signs the raw POST body; `express.json()` consumes the stream and the signature verification fails. By mounting `express.raw()` only on the webhook route, the rest of the app can still use JSON middleware normally.

### Why we always return 200

WhatsApp providers retry on non-2xx. If we return 500 because of an internal bug, they'll keep redelivering the same message every few seconds, compounding the problem. Better policy: always 200 once the request is parseable; log the error internally; ops investigates from logs. The one exception is **invalid signature** — we return 401 so providers and load tests can distinguish real auth failures from "we got it".

### Why we don't run JSON middleware globally

This bot has exactly one ingress endpoint (the webhook) and a healthcheck. Adding more routes later? Mount JSON middleware on those specific routes. Global JSON middleware breaks signature verification for any provider that signs the raw body.

## Server bootstrap

`src/server.ts` is the canonical wiring. It reads config, builds every component, mounts the router, and listens. Tests can call `buildApp()` for a fully wired Express app without binding a port.

```typescript
import { buildApp, startServer } from './server';

// In production:
startServer();   // reads env, listens on PORT, handles SIGTERM/SIGINT

// In tests:
const { app, shutdown } = buildApp(testConfig);
await request(app).post('/webhook')...
await shutdown();
```

## Test coverage

15 webhook handler tests using `supertest`:
- Twilio HMAC-SHA1 signature verification (valid → 200, invalid → 401, missing → 401)
- Twilio status callbacks (delivered receipts) → 200, no processing
- Twilio duplicate delivery → idempotency catches it, only one outbound send
- Meta GET challenge handshake (correct token → echo, wrong token → 404)
- Meta HMAC-SHA256 signature verification
- Healthcheck endpoint
