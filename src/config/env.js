const DEFAULTS = {
  PORT: '4100',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  BOT_PROVIDER: 'twilio',
  BACKEND_MODE: 'mock',
  SESSION_TTL_SECONDS: '1800',
  IDEMPOTENCY_TTL_SECONDS: '86400',
  TWILIO_REPLY_MODE: 'twiml',
  META_GRAPH_API_VERSION: 'v22.0',
  GRIDEE_KWH_RATE_NAIRA: '48',
  GRIDEE_MIN_TOPUP_NAIRA: '2000',
  MOCK_OTP_CODE: '123456',
};

function readEnv(name) {
  return process.env[name] ?? DEFAULTS[name] ?? '';
}

function toInt(name) {
  const value = Number(readEnv(name));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid integer environment value for ${name}`);
  }
  return value;
}

function oneOf(name, allowed) {
  const value = readEnv(name).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

export function loadEnv() {
  return Object.freeze({
    port: toInt('PORT'),
    nodeEnv: readEnv('NODE_ENV'),
    logLevel: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error']),
    botProvider: oneOf('BOT_PROVIDER', ['twilio', 'meta']),
    backendMode: oneOf('BACKEND_MODE', ['mock', 'http']),
    backendBaseUrl: readEnv('GRIDEE_BACKEND_BASE_URL').replace(/\/$/, ''),
    backendApiKey: readEnv('GRIDEE_BACKEND_API_KEY'),
    backendSharedSecret: readEnv('GRIDEE_BACKEND_SHARED_SECRET'),
    sessionTtlSeconds: toInt('SESSION_TTL_SECONDS'),
    idempotencyTtlSeconds: toInt('IDEMPOTENCY_TTL_SECONDS'),
    twilio: Object.freeze({
      accountSid: readEnv('TWILIO_ACCOUNT_SID'),
      authToken: readEnv('TWILIO_AUTH_TOKEN'),
      whatsappFrom: readEnv('TWILIO_WHATSAPP_FROM'),
      replyMode: oneOf('TWILIO_REPLY_MODE', ['twiml', 'api']),
    }),
    meta: Object.freeze({
      verifyToken: readEnv('META_VERIFY_TOKEN'),
      appSecret: readEnv('META_APP_SECRET'),
      accessToken: readEnv('META_ACCESS_TOKEN'),
      phoneNumberId: readEnv('META_PHONE_NUMBER_ID'),
      graphApiVersion: readEnv('META_GRAPH_API_VERSION'),
    }),
    business: Object.freeze({
      kwhRateNaira: Number(readEnv('GRIDEE_KWH_RATE_NAIRA')),
      minTopupNaira: Number(readEnv('GRIDEE_MIN_TOPUP_NAIRA')),
      mockOtpCode: readEnv('MOCK_OTP_CODE'),
    }),
  });
}
