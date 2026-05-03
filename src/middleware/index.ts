import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger';

/**
 * Attaches a per-request correlation ID and a child logger to req.
 * The logger redacts PII (configured in lib/logger).
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const requestId =
    typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : randomUUID();
  res.setHeader('x-request-id', requestId);

  const start = Date.now();
  const log = logger.child({ requestId, method: req.method, path: req.path });
  // Attach to the request for downstream handlers (typed via module augmentation
  // if you want — for now any handler that needs it can pull off req as below).
  (req as { log?: typeof logger }).log = log;

  log.info('→ request');

  res.on('finish', () => {
    log.info({ status: res.statusCode, durationMs: Date.now() - start }, '← response');
  });

  next();
};

/**
 * Last-resort error middleware. By the time we get here, something
 * downstream forgot to handle a rejection. We log and respond 500.
 *
 * NOTE: the webhook handler should NEVER reach here — it explicitly catches
 * every error. This middleware is for the rest of the server.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error(
    { err: (err as Error).message, stack: (err as Error).stack },
    'Unhandled error reached error middleware',
  );
  if (res.headersSent) {
    // Already streamed something — can't change status. Just close.
    res.end();
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};

/** Healthcheck for liveness/readiness probes. */
export const healthCheck: RequestHandler = (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
};
