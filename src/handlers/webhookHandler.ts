import type { Request, Response, RequestHandler } from 'express';
import type { MessageDispatcher } from '../dispatcher';
import { logger } from '../lib/logger';
import { InboundParseError, type IMessagingProvider } from '../messaging';

export interface WebhookHandlerDeps {
  provider: IMessagingProvider;
  dispatcher: MessageDispatcher;
}

/**
 * Build Express handlers for the messaging provider's webhook endpoint.
 *
 * USAGE in routes file:
 *
 *   const wh = makeWebhookHandlers({ provider, dispatcher });
 *   router.get('/webhook',  wh.challenge);         // Meta verification (GET)
 *   router.post('/webhook',
 *     express.raw({ type: '*\/*', limit: '1mb' }),  // raw body for sig verify
 *     wh.inbound,
 *   );
 *
 * IMPORTANT — ROUTE-SCOPED RAW BODY:
 *   Twilio's signature is computed over POST form params, but we pass the
 *   raw body to verifySignature so providers that need it (Meta) can use it.
 *   We mount express.raw() ONLY on the webhook route to avoid breaking JSON
 *   parsing on the rest of the app.
 *
 *   For Twilio specifically, Express's `raw()` gives us a Buffer and the
 *   provider needs to see the body as parsed form data (req.body as Record).
 *   We parse the raw body ourselves below depending on Content-Type.
 *
 * RESPONSE POLICY:
 *   This handler ALWAYS returns 200 once the request is parsed. Returning
 *   non-200 makes providers retry, which compounds problems. The dispatcher
 *   logs errors internally; ops sees them in the logs, the provider does not.
 */
export function makeWebhookHandlers(deps: WebhookHandlerDeps): {
  challenge: RequestHandler;
  inbound: RequestHandler;
} {
  const { provider, dispatcher } = deps;

  return {
    /**
     * GET /webhook — provider verification challenge handshake.
     * Used by Meta's WhatsApp Cloud API. Twilio and AT return null here
     * and we respond with 404 since GET isn't part of their flow.
     */
    challenge: async (req: Request, res: Response): Promise<void> => {
      try {
        const echo = provider.verifyChallenge(req);
        if (echo !== null) {
          res.status(200).type('text/plain').send(echo);
          return;
        }
        res.status(404).end();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Challenge handler threw');
        res.status(500).end();
      }
    },

    /**
     * POST /webhook — inbound message webhook.
     *
     * Order of operations is critical:
     *   1. Verify signature against the RAW body (and any headers)
     *   2. Populate req.body from raw bytes so provider.verifySignature() can
     *      use parsed form data when needed (Twilio)
     *   3. Parse inbound message
     *   4. Dispatch (always returns; never throws to caller)
     *   5. Respond 200
     */
    inbound: async (req: Request, res: Response): Promise<void> => {
      // Express.raw() leaves req.body as a Buffer. If it isn't a Buffer here,
      // someone forgot to mount raw() on this route.
      const rawBody: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      const contentType = (req.headers['content-type'] ?? '').toString();

      // Twilio's signature math needs req.body as a parsed object (form params).
      // For application/x-www-form-urlencoded, we parse here so the provider
      // can use it; for application/json we don't need to (Meta uses raw bytes).
      if (contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
        const parsed = new URLSearchParams(rawBody.toString('utf8'));
        const obj: Record<string, string> = {};
        for (const [k, v] of parsed) obj[k] = v;
        // Express's `req.body` is loosely typed `any`; this overwrite is fine.
        (req as { body: unknown }).body = obj;
      }

      // 1. Signature verification — fail closed
      let signatureValid: boolean;
      try {
        signatureValid = provider.verifySignature(req, rawBody);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Signature verification threw');
        signatureValid = false;
      }
      if (!signatureValid) {
        // Bad / missing signature — 401, do NOT process. This is the only
        // case where we don't return 200 (provider retries are fine here;
        // they'll keep failing the same way).
        logger.warn({ ip: req.ip }, 'Inbound webhook signature invalid');
        res.status(401).end();
        return;
      }

      // 2. Parse — null = status callback (no inbound message), error = junk
      let inbound;
      try {
        inbound = provider.parseInbound(rawBody, contentType);
      } catch (err) {
        if (err instanceof InboundParseError) {
          logger.warn({ err: err.message }, 'Inbound parse failed');
        } else {
          logger.error({ err: (err as Error).message }, 'Inbound parse threw unexpected error');
        }
        // Always 200 — the provider would retry forever otherwise.
        res.status(200).end();
        return;
      }

      if (inbound === null) {
        // Status callback (delivered/read/etc.) or non-text message — ack and skip.
        res.status(200).end();
        return;
      }

      // 3. Dispatch — never throws; returns DispatchOutcome
      try {
        await dispatcher.dispatch(inbound);
      } catch (err) {
        // Defensive — dispatch() should never throw, but if it does, log and ack.
        logger.error(
          { err: (err as Error).message, stack: (err as Error).stack },
          'Dispatcher threw unexpectedly',
        );
      }

      // 4. ALWAYS 200
      res.status(200).end();
    },
  };
}
