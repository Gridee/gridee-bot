# Templates (`gridee-bot/src/templates/`)

User-facing copy. **Mark David owns the production copy** — the file shipped here is a working English default that the bot uses today.

## Why this module exists

Per SCREENS.md, all user-facing strings must come from a single source so that:
- Translations (English / Pidgin) can be applied uniformly
- Wording can be tweaked centrally without grepping flow code
- The bot's flow logic stays focused on state transitions, not copy

Bot code never composes user-facing strings inline. It calls `templates.X(...)`.

## How to swap implementations

```typescript
import { type ITemplates, DefaultTemplates } from './templates';

// Production:
import { ProductionTemplates } from '@gridee/templates'; // Mark's package, future
const templates: ITemplates = new ProductionTemplates({ locale: 'en-NG' });

// Tests / dev:
const templates: ITemplates = new DefaultTemplates();
```

The `ITemplates` interface is the contract. Implementations swap freely.

## What's covered

23 template methods grouped by:
- **Welcome & role selection** (1)
- **Landlord registration** (3)
- **Tenant registration** (4)
- **ADD PROPERTY** (4 — chained from landlord auth per SCREENS.md)
- **Welcome & onboarding success** (2)
- **Errors** (12)
- **BUY flow** (5)

When SCREENS.md grows, add the corresponding method to `ITemplates`. The bot's flows will fail to compile until you do — the type system is the contract enforcer.

## What's NOT covered yet

These will be added when their respective flows are built:
- `WITHDRAW_BANK_INPUT` / `WITHDRAW_CONFIRM` / `WITHDRAWAL_INITIATED`
- `REMOVE_TENANT_PHONE` / `REMOVE_TENANT_CONFIRM` / `TENANT_REMOVED_LANDLORD` / `TENANT_REMOVED_EVICTED`
- `MY_PROPERTIES_LIST` / `PROPERTY_DETAIL` / `TENANTS_LIST` / `EARNINGS_OVERVIEW`
- `BALANCE_VIEW` / `HISTORY_VIEW`
- Push notifications: `ALERT_LOW_BALANCE`, `ALERT_CUTOFF`, `ALERT_RESTORED`, etc. (these live on the backend's notification service, not here)
