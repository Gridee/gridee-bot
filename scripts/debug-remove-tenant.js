import { BotRouter } from '../src/bot/bot-router.js';
import { RedisSessionStore } from '../src/session/session-store.js';
import { ScreenId } from '../src/core/screen-id.js';
import { ActiveCommand } from '../src/core/commands.js';
import ioredis from 'ioredis';

const redis = new ioredis('redis://localhost:6379');
const sessionStore = new RedisSessionStore(redis);

const phone = 'whatsapp:+2348148915475';
const propertyCode = 'GRD-OYO-2867';
const tenantPhone = '+2347037730398';

async function debug() {
  console.log('--- Debugging Remove Tenant Flow ---');
  
  // 1. Manually set session to the step where we enter phone
  await sessionStore.set(phone, {
    role: 'landlord',
    activeCommand: ActiveCommand.REMOVE_TENANT,
    step: ScreenId.REMOVE_TENANT_PHONE,
    data: { propertyCode },
  });

  // 2. Create a mock router (we only need the flow logic)
  const router = new BotRouter({ 
    sessionStore, 
    idempotencyStore: { has: () => false, remember: () => {} },
    backend: { resolveUser: () => ({ user: { role: 'landlord' } }) },
    logger: { debug: console.log, error: console.error, info: console.log }
  });

  // 3. Send the phone number input
  console.log(`Sending tenant phone: ${tenantPhone}`);
  const result = await router.handleInbound({ phone, text: tenantPhone });

  console.log('\nBot Response:');
  console.log(result.text);
  
  await redis.quit();
}

debug().catch(console.error);
