import http from 'http';
import { readRawBody, parseBody, sendJson, sendText } from './body-parser.js';

export function createServer({ env, provider, botRouter, logger }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok', provider: provider.name });
      }

      if (request.method === 'GET' && url.pathname === '/webhooks/whatsapp') {
        if (provider.name !== 'meta') return sendJson(response, 200, { ok: true });
        const verification = provider.verifyWebhook({ query: Object.fromEntries(url.searchParams) });
        if (!verification.ok) return sendJson(response, 403, { error: 'Invalid verification token' });
        return sendText(response, 200, verification.challenge);
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/whatsapp') {
        const rawBody = await readRawBody(request);
        const contentType = request.headers['content-type'] || '';
        const body = parseBody(rawBody, contentType);

        if (provider.name === 'meta' && !provider.verifySignature({ rawBody, headers: request.headers })) {
          return sendJson(response, 401, { error: 'Invalid signature' });
        }

        const inboundMessages = provider.parseInbound({ body, headers: request.headers });
        logger.debug('Inbound webhook received', { count: inboundMessages.length, provider: provider.name });

        if (provider.name === 'twilio' && provider.shouldReplyWithTwiml()) {
          const message = inboundMessages[0];
          if (!message) return sendText(response, 200, provider.twiml(''), 'application/xml');
          const result = await botRouter.handleInbound(message);
          const text = result.type === 'reply' ? result.text : '';
          return sendText(response, 200, provider.twiml(text), 'application/xml');
        }

        for (const message of inboundMessages) {
          const result = await botRouter.handleInbound(message);
          if (result.type === 'reply') await provider.sendText({ to: message.phone, text: result.text });
        }
        return sendJson(response, 200, { ok: true });
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      logger.error('Request failed', { error: error.message, stack: error.stack });
      const userMessage = error.message.includes('Unexpected token') 
        ? '⚠️ The payment service is currently busy. Please try again in a moment.' 
        : '⚠️ Sorry, something went wrong on our end. Please type HELP to restart.';

      if (provider.name === 'twilio' && provider.shouldReplyWithTwiml()) {
        return sendText(response, 200, provider.twiml(userMessage), 'application/xml');
      }
      return sendJson(response, 500, { error: 'Internal server error', message: userMessage });
    }
  });
}
