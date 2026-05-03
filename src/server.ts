import express, { type Express } from 'express';
import { BackendClient } from './client';
import { CommandRegistry } from './commands';
import { loadConfig, type Config } from './config';
import {
  IdempotencyStoreFactory,
  MessageDispatcher,
  type IInboundIdempotencyStore,
} from './dispatcher';
import { FlowRegistry } from './flows';
import { logger } from './lib/logger';
import {
  MessagingProviderFactory,
  type IMessagingProvider,
} from './messaging';
import { errorHandler, requestLogger } from './middleware';
import { makeRouter } from './routes';
import {
  SessionStoreFactory,
  type ISessionStore,
} from './session';
import { DefaultTemplates } from './templates';

export interface AppHandle {
  app: Express;
  config: Config;
  /** Disposes connection pools (Redis, etc). Call on shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Build a fully wired Express app.
 *
 * This is the single source of truth for production wiring. Tests can build
 * a mini version of this with stubbed deps to exercise the full HTTP path.
 */
export function buildApp(overrideConfig?: Config): AppHandle {
  const config = overrideConfig ?? loadConfig();

  // ── Stores ────────────────────────────────────────────────────────────
  const sessionStore: ISessionStore = SessionStoreFactory.create({
    type: config.SESSION_STORE,
    ttlSeconds: config.SESSION_TTL_SECONDS,
    ...(config.REDIS_URL !== undefined ? { redisUrl: config.REDIS_URL } : {}),
    ...(config.REDIS_NAMESPACE !== undefined ? { redisNamespace: config.REDIS_NAMESPACE } : {}),
  });

  // Idempotency store — same flavor as session store, sharing Redis if used
  const idempotencyStore: IInboundIdempotencyStore = IdempotencyStoreFactory.create({
    type: config.SESSION_STORE, // mirrors session — memory or redis
    ...(config.REDIS_URL !== undefined ? { redisUrl: config.REDIS_URL } : {}),
    redisNamespace: `${config.REDIS_NAMESPACE ?? 'gridee'}:inbound`,
  });

  // ── Provider ──────────────────────────────────────────────────────────
  const provider: IMessagingProvider = MessagingProviderFactory.create({
    type: config.MESSAGING_PROVIDER,
    ...(config.TWILIO_ACCOUNT_SID !== undefined ? { twilioAccountSid: config.TWILIO_ACCOUNT_SID } : {}),
    ...(config.TWILIO_AUTH_TOKEN !== undefined ? { twilioAuthToken: config.TWILIO_AUTH_TOKEN } : {}),
    ...(config.TWILIO_WHATSAPP_FROM !== undefined ? { twilioWhatsappFrom: config.TWILIO_WHATSAPP_FROM } : {}),
    ...(config.TWILIO_PUBLIC_WEBHOOK_URL !== undefined
      ? { twilioPublicWebhookUrl: config.TWILIO_PUBLIC_WEBHOOK_URL }
      : {}),
    ...(config.WHATSAPP_CLOUD_ACCESS_TOKEN !== undefined
      ? { whatsappCloudAccessToken: config.WHATSAPP_CLOUD_ACCESS_TOKEN }
      : {}),
    ...(config.WHATSAPP_CLOUD_PHONE_NUMBER_ID !== undefined
      ? { whatsappCloudPhoneNumberId: config.WHATSAPP_CLOUD_PHONE_NUMBER_ID }
      : {}),
    ...(config.WHATSAPP_CLOUD_APP_SECRET !== undefined
      ? { whatsappCloudAppSecret: config.WHATSAPP_CLOUD_APP_SECRET }
      : {}),
    ...(config.WHATSAPP_CLOUD_VERIFY_TOKEN !== undefined
      ? { whatsappCloudVerifyToken: config.WHATSAPP_CLOUD_VERIFY_TOKEN }
      : {}),
    ...(config.AT_API_KEY !== undefined ? { atApiKey: config.AT_API_KEY } : {}),
    ...(config.AT_USERNAME !== undefined ? { atUsername: config.AT_USERNAME } : {}),
    ...(config.AT_SENDER_ID !== undefined ? { atSenderId: config.AT_SENDER_ID } : {}),
    ...(config.AT_WEBHOOK_SECRET !== undefined ? { atWebhookSecret: config.AT_WEBHOOK_SECRET } : {}),
  });

  // ── Backend client + flows + templates ────────────────────────────────
  const client = new BackendClient({
    baseUrl: config.BACKEND_API_URL,
    timeoutMs: config.BACKEND_API_TIMEOUT_MS,
  });
  const flowRegistry = FlowRegistry.default();
  const commandRegistry = CommandRegistry.default();
  const templates = new DefaultTemplates();

  // ── Dispatcher ─────────────────────────────────────────────────────────
  const dispatcher = new MessageDispatcher({
    sessionStore,
    idempotencyStore,
    flowRegistry,
    commandRegistry,
    sender: provider,
    client,
    templates,
  });

  // ── Express app ────────────────────────────────────────────────────────
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger);

  // Note: NO global express.json() here. JSON middleware is mounted only on
  // routes that need it (none yet). The webhook route mounts express.raw()
  // route-locally inside makeRouter().
  app.use(makeRouter({ provider, dispatcher, webhookPath: config.WEBHOOK_PATH }));

  // Error middleware MUST be last
  app.use(errorHandler);

  // ── Shutdown hook ─────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down');
    try {
      await sessionStore.close();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'sessionStore close failed');
    }
    try {
      await idempotencyStore.close();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'idempotencyStore close failed');
    }
  };

  return { app, config, shutdown };
}

/** Standalone server entry point. */
export async function startServer(): Promise<void> {
  const { app, config, shutdown } = buildApp();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'gridee-bot listening');
  });

  // Graceful shutdown on SIGTERM/SIGINT
  const onSignal = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal');
    server.close();
    await shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void onSignal('SIGTERM'));
  process.on('SIGINT', () => void onSignal('SIGINT'));
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.fatal({ err: (err as Error).message, stack: (err as Error).stack }, 'Server failed to start');
    process.exit(1);
  });
}
