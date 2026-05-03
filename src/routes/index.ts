import express, { Router } from 'express';
import { makeWebhookHandlers, type WebhookHandlerDeps } from '../handlers';
import { healthCheck } from '../middleware';

export interface RoutesDeps extends WebhookHandlerDeps {
  /** Path the messaging provider POSTs to. Default '/webhook'. */
  webhookPath?: string;
  /** Max raw body size accepted for webhooks. Default '1mb'. */
  webhookBodyLimit?: string;
}

/**
 * Build the application's router.
 *
 * Mounting note: `express.raw()` is mounted ONLY on the webhook route.
 * Other routes (health, future admin endpoints) get the default JSON parser
 * mounted by `server.ts`.
 */
export function makeRouter(deps: RoutesDeps): Router {
  const router = Router();
  const path = deps.webhookPath ?? '/webhook';
  const limit = deps.webhookBodyLimit ?? '1mb';

  const handlers = makeWebhookHandlers({
    provider: deps.provider,
    dispatcher: deps.dispatcher,
  });

  // Health
  router.get('/health', healthCheck);

  // Webhook — challenge (GET) and inbound (POST)
  router.get(path, handlers.challenge);
  router.post(path, express.raw({ type: '*/*', limit }), handlers.inbound);

  return router;
}
