# Flows (`gridee-bot/src/flows/`)

Multi-step conversation state machines. Each flow owns a contiguous set of `SessionStep`s and translates an incoming message into a `FlowResult` describing what the dispatcher should do next.

## TL;DR

```typescript
import { FlowRegistry } from './flows';
import { BackendClient } from './client';
import { DefaultTemplates } from './templates';
import { Phone } from './lib/phone';
import { logger } from './lib/logger';

const registry = FlowRegistry.default();   // 4 flows: RoleSelection, LandlordOnboarding, TenantOnboarding, Buy
const client = new BackendClient({ baseUrl: '...' });
const templates = new DefaultTemplates();  // Mark replaces with production copy

// Inside the dispatcher, after locking the session:
const flow = registry.findForStep(session.step);
if (!flow) {
  // No active flow — route to commands or send role prompt
} else {
  const result = await flow.handle({ phone, session, client, templates, log: logger }, message);
  // result is a discriminated union — see "FlowResult" below
}
```

## File map

| File | Role |
|---|---|
| `IFlow.ts` | Interface, `FlowContext`, `FlowResult`, `SessionPatch` |
| `helpers.ts` | Shared parsers (phone, OTP, property code, etc.) and error → reply mapper |
| `RoleSelectionFlow.ts` | Single-step entry: maps "1"/"2" → branch into landlord or tenant |
| `LandlordOnboardingFlow.ts` | 7 chained steps: name → phone → OTP → address → flat count → label → done |
| `TenantOnboardingFlow.ts` | 4 chained steps: name → phone → OTP → property code → done |
| `BuyFlow.ts` | 3 steps: amount → confirm → awaiting payment |
| `FlowRegistry.ts` | Step → flow lookup; throws on overlap at construction |
| `index.ts` | Public exports |

## Design principles

### Flows don't send messages or save sessions

A flow handler returns a `FlowResult` describing intent — it does not call `sender.sendMessage()` or `store.set()`. The dispatcher (next module) does both. This makes flows pure-ish and trivially unit-testable: no mocking of the messaging or session layers needed.

### `FlowResult` is a discriminated union

```typescript
type FlowResult =
  | { kind: 'advance';     reply, patch }   // send reply, move to new step
  | { kind: 'stay';        reply, patch? }  // send reply, keep step (e.g. invalid input)
  | { kind: 'complete';    reply, patch }   // flow finished, terminal step
  | { kind: 'reset';       reply }          // clear session, go back to role prompt
  | { kind: 'passthrough' }                 // not my problem — dispatcher routes elsewhere
```

The dispatcher's switch over this union is exhaustively checked — adding a new variant breaks the build until handled.

### `SessionPatch` is a partial update, not a full state

Flows return *what changed*, not the new state. The dispatcher merges. This means a handler doesn't need to remember to copy unchanged fields — only spell out what's different.

### Step-aware parsing

A flow handler always knows what step it's on. A "1" sent during `WELCOME_ROLE_SELECT` is "I'm a landlord"; a "1" sent during `BUY_CONFIRM` is "bank transfer"; a "1" sent during `ADD_PROPERTY_FLAT_COUNT` is "one flat". Each handler does its own parsing. **There is no global "if input == '1'" anywhere.**

### Backend errors are user-friendly

Every `BackendError` is mapped to a `FlowResult` via `backendErrorToFlowResult`:

| Error class | Result |
|---|---|
| `BackendAuthError` (401) | `reset` — session JWT cleared |
| `BackendNetworkError` | `stay` with "try again" message |
| `BackendContractError` | `stay` with generic error (logged loudly) |
| `BackendApiError` with known code | `stay`/`reset` with specific template |
| Anything else | `stay` with generic error |

### OTP attempts are bounded

Each flow tracks `otpAttempts` in `session.data`, capped at `MAX_OTP_ATTEMPTS = 3`. After that, the flow returns `reset` to prevent abuse.

### Property codes are normalized

`grd-lag-0042` → `GRD-LAG-0042` before backend call. User can type either case.

### Names allow Unicode

`parseFullName()` accepts Unicode letters, spaces, hyphens, apostrophes, dots. So `O'Brien-Adekunle`, `Chinwe`, `Aminat` all work. Digits and emojis don't.

## Adding a new flow

1. Create `src/flows/MyFlow.ts` implementing `IFlow`
2. Define `private static readonly STEPS` — the steps you handle
3. `handle()` switches on `ctx.session.step` and delegates to private handlers
4. Each handler returns a `FlowResult`
5. Register in `FlowRegistry.default()` (or pass via DI)
6. Add tests in `tests/flows/MyFlow.test.ts` using the `harness.ts` utilities

The registry's `detectOverlap()` will throw at construction if your new flow claims a step that another flow already handles.

## Test coverage

```bash
npm test -- flows
```

124 flow tests covering:
- Every step's happy path
- Every step's error paths (invalid input, missing data, backend failures)
- End-to-end happy-path walkthrough for landlord onboarding (driving the full state machine through 6 steps with patch application)
- Registry overlap detection
- All input parsing edge cases (lowercase property codes, comma-separated naira amounts, etc.)
