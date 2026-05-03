/**
 * Example: how the dispatcher uses the session store.
 *
 * This file is for documentation only — delete or relocate when wiring the
 * real dispatcher.
 */

import { loadConfig } from './config';
import { logger } from './lib/logger';
import { Phone, SessionStoreFactory, newSessionState, type ISessionStore } from './session';

async function example(): Promise<void> {
  const config = loadConfig();

  // Single line — env decides which implementation. Default is 'memory'.
  const store: ISessionStore = SessionStoreFactory.create({
    type: config.SESSION_STORE,
    ttlSeconds: config.SESSION_TTL_SECONDS,
    ...(config.REDIS_URL !== undefined ? { redisUrl: config.REDIS_URL } : {}),
    ...(config.REDIS_NAMESPACE !== undefined ? { redisNamespace: config.REDIS_NAMESPACE } : {}),
  });

  const phone = Phone.of('+2348031234567');

  // ── Typical inbound webhook handler pattern ──────────────────────────────
  //
  // Lock the phone first, then read-modify-write inside the lock. This is
  // what prevents two concurrent webhook deliveries for the same phone from
  // double-progressing the flow.

  await store.withLock(phone, async () => {
    let session = await store.get(phone);

    if (!session) {
      // First contact — initialize at the welcome step
      session = newSessionState({ step: 'WELCOME_ROLE_SELECT' });
      await store.set(phone, session);
      logger.info('New session created');
      return;
    }

    // Advance the flow based on current step + incoming message.
    // (Real dispatcher logic goes in src/dispatcher/, not here.)
    switch (session.step) {
      case 'WELCOME_ROLE_SELECT':
        // ... handle role selection ...
        break;
      case 'LANDLORD_REG_NAME':
        // ... handle name input ...
        break;
      // ... etc.
      default:
        // Exhaustiveness checked elsewhere
        break;
    }

    await store.set(phone, { ...session, updatedAt: Date.now() });
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────
  await store.close();
}

// Top-level invocation guard so importing doesn't run example
if (require.main === module) {
  example().catch((err) => {
    logger.error({ err }, 'Example failed');
    process.exit(1);
  });
}
