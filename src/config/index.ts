import { z } from 'zod';
import { ConfigError } from '../lib/errors';

/**
 * Env schema. All values are read at boot, validated, and frozen into a
 * single typed config object. No `process.env.X` reads anywhere else in the
 * codebase — refer to `config` instead.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Session
  SESSION_STORE: z.enum(['memory', 'redis']).default('memory'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(1800), // 30 min per PRD

  // Redis (only required if SESSION_STORE === 'redis')
  REDIS_URL: z.string().url().optional(),
  REDIS_NAMESPACE: z.string().min(1).optional(),

  // Backend API
  BACKEND_API_URL: z.string().url().default('http://localhost:3000'),
  BACKEND_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // Messaging provider — Twilio in test, anything cost-effective in prod via factory
  MESSAGING_PROVIDER: z.enum(['twilio', 'whatsapp_cloud', 'africas_talking']).default('twilio'),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TWILIO_PUBLIC_WEBHOOK_URL: z.string().url().optional(),

  // WhatsApp Cloud (Meta)
  WHATSAPP_CLOUD_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_CLOUD_APP_SECRET: z.string().optional(),
  WHATSAPP_CLOUD_VERIFY_TOKEN: z.string().optional(),

  // Africa's Talking
  AT_API_KEY: z.string().optional(),
  AT_USERNAME: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),
  AT_WEBHOOK_SECRET: z.string().optional(),

  // Server
  PORT: z.coerce.number().int().positive().default(3001),
  /**
   * Path the messaging provider POSTs to. Defaults to '/webhook'.
   * Useful when running multiple providers behind one host (e.g.
   * '/webhook/twilio' for Twilio, '/webhook/whatsapp_cloud' for Meta).
   * Must start with '/'.
   */
  WEBHOOK_PATH: z
    .string()
    .startsWith('/', { message: 'WEBHOOK_PATH must start with "/"' })
    .default('/webhook'),
});

export type Config = Readonly<z.infer<typeof EnvSchema>>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }

  // Cross-field validation: redis store needs URL
  if (result.data.SESSION_STORE === 'redis' && !result.data.REDIS_URL) {
    throw new ConfigError("REDIS_URL is required when SESSION_STORE='redis'");
  }

  // Cross-field validation: TWILIO_PUBLIC_WEBHOOK_URL path must match WEBHOOK_PATH
  // (Twilio signs the exact URL it calls; mismatches cause 401 on every inbound)
  if (result.data.TWILIO_PUBLIC_WEBHOOK_URL) {
    const url = new URL(result.data.TWILIO_PUBLIC_WEBHOOK_URL);
    if (url.pathname !== result.data.WEBHOOK_PATH) {
      throw new ConfigError(
        `TWILIO_PUBLIC_WEBHOOK_URL path "${url.pathname}" does not match WEBHOOK_PATH "${result.data.WEBHOOK_PATH}". ` +
          `Twilio signs the exact URL it calls; a mismatch will fail signature verification on every inbound message.`,
      );
    }
  }

  cached = Object.freeze(result.data);
  return cached;
}

/** Test-only — reset the cache so tests can inject different env shapes. */
export function _resetConfigForTests(): void {
  cached = null;
}
