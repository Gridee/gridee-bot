import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  // Keep PII out of logs at the formatter level.
  redact: {
    paths: ['phone', 'jwt', 'otp', '*.phone', '*.jwt', '*.otp'],
    remove: true,
  },
});
