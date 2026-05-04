import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createProvider } from './providers/provider.factory.js';
import { createBackendClient } from './backend/create-backend-client.js';
import { RedisIdempotencyStore, RedisSessionStore } from './session/session-store.js';
import { BotRouter } from './bot/bot-router.js';
import { createServer } from './http/server.js';

const env = loadEnv();
const logger = createLogger(env.logLevel);
const provider = createProvider(env, logger);
const backend = createBackendClient(env);
const sessionStore = new RedisSessionStore({ url: env.redisUrl, ttlSeconds: env.sessionTtlSeconds });
const idempotencyStore = new RedisIdempotencyStore({ url: env.redisUrl, ttlSeconds: env.idempotencyTtlSeconds });
const botRouter = new BotRouter({
  sessionStore,
  idempotencyStore,
  backend,
  business: env.business,
  logger,
});

const server = createServer({ env, provider, botRouter, logger });

server.listen(env.port, () => {
  logger.info('Gridee WhatsApp bot listening', {
    port: env.port,
    provider: provider.name,
    backendMode: env.backendMode,
  });
});

function shutdown(signal) {
  logger.info('Shutdown signal received', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
