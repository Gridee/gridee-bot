# Commands (`gridee-bot/src/commands/`)

Stateless one-shot commands for the post-flow idle state. When a user is at `TENANT_AUTHENTICATED`, `LANDLORD_AUTHENTICATED`, or `AWAITING_PAYMENT` (where BuyFlow returns passthrough), the dispatcher routes their message through the command registry instead of through a flow.

## Files

| File | Role |
|---|---|
| `ICommand.ts` | Interface + `CommandResult` types (reply / reply+patch / unhandled) |
| `MenuCommand.ts` | MENU / HOME — works for any role and any step (bypasses flow dispatch) |
| `HelpCommand.ts` | HELP — works for any role; shows role-appropriate menu |
| `BalanceCommand.ts` | BALANCE — tenant only; calls `getBalance()` |
| `HistoryCommand.ts` | HISTORY — tenant only; calls `getHistory(limit=10)` |
| `MyPropertiesCommand.ts` | MY_PROPERTIES (or PROPERTIES, MY PROPERTIES) — landlord only |
| `EarningsCommand.ts` | EARNINGS — landlord only |
| `CommandRegistry.ts` | First-match registry; default has all 6 commands |
| `index.ts` | Public exports |

## MENU / HOME — the global escape hatch

MENU and HOME are special: they bypass flow dispatch entirely. The dispatcher checks `isGlobalCommand(text)` BEFORE looking up the flow for the current step. This means a confused user can type `MENU` from anywhere — mid-onboarding, mid-buy, stuck at `AWAITING_PAYMENT` after a backend-confirmed payment — and reset to a known-good state.

Reset semantics:
- **Tenant** → `TENANT_AUTHENTICATED`, jwt/userId/role preserved, partial flow data cleared
- **Landlord** → `LANDLORD_AUTHENTICATED`, same
- **Unauthenticated** → `WELCOME_ROLE_SELECT`, restart onboarding

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│ Dispatcher tryCommandOrNudge(inbound, session)                   │
│                                                                   │
│ if commandRegistry === null:                                     │
│   send errorInvalidInput nudge                                   │
│   return                                                          │
│                                                                   │
│ result = commandRegistry.handle(ctx, message)                    │
│                                                                   │
│ if result === null:                                              │
│   if role is set:                                                 │
│     send unrecognizedCommand nudge ("type HELP to see...")       │
│   else:                                                           │
│     send errorInvalidInput                                        │
│   return                                                          │
│                                                                   │
│ if result.kind === 'reply':                                      │
│   send result.text                                                │
│                                                                   │
│ if result.kind === 'reply+patch':                                │
│   send result.text                                                │
│   apply session patch                                             │
│                                                                   │
│ if result.kind === 'unhandled':                                  │
│   (matches() lied — fall through to nudge)                       │
└──────────────────────────────────────────────────────────────────┘
```

## Backward compatibility

`MessageDispatcher` accepts `commandRegistry` as **optional**. When omitted (e.g., older tests, simpler harnesses), the dispatcher falls back to the original "generic nudge" behavior. Existing tests don't need to change.

## Role-scoping

Each command's `matches()` checks the session role:

```typescript
matches(message: string, session: SessionState): boolean {
  return (
    session.role === 'tenant' &&
    message.trim().toUpperCase() === 'BALANCE'
  );
}
```

This means a tenant typing `MY_PROPERTIES` gets the unrecognized nudge (no command matches), not an authorization error. Same for a landlord typing `BALANCE`.

## A real bug surfaced by these tests

The new tests caught that `LandlordOnboardingFlow` was claiming `LANDLORD_AUTHENTICATED` as one of its handled steps, with a transient handler that immediately advanced to `ADD_PROPERTY_ADDRESS`. This meant a landlord typing `MY_PROPERTIES` after onboarding routed back into onboarding instead of to commands.

Fix: removed `LANDLORD_AUTHENTICATED` from the flow's STEPS set. Commands handle it now. The dispatcher's no-flow branch fires `tryCommandOrNudge` when it lands here.

## Test coverage

56 tests covering:
- Each command's `matches()` for valid + invalid messages, with role scoping
- Each command's happy path with backend stub returning data
- Each command's failure path (missing JWT, backend error)
- `CommandRegistry.find()` first-match semantics and role-scoping
- Dispatcher integration: idle authenticated routes to commands; passthrough from BuyFlow routes to commands; wrong-role messages get unrecognized nudge; backward-compat when registry is omitted
- MENU bypasses flow dispatch from any step (AWAITING_PAYMENT, mid-onboarding, mid-buy); preserves auth; clears partial data; allows BUY shortcut to work after reset
