import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from '../../src/dispatcher/InboundIdempotencyStore';
import { MessageDispatcher } from '../../src/dispatcher/MessageDispatcher';
import { FlowRegistry } from '../../src/flows';
import { TwilioProvider } from '../../src/messaging/providers/TwilioProvider';
import { WhatsAppCloudProvider } from '../../src/messaging/providers/WhatsAppCloudProvider';
import { makeRouter } from '../../src/routes';
import { InMemorySessionStore } from '../../src/session/InMemorySessionStore';
import { DefaultTemplates } from '../../src/templates';
import { FakeBackendClient } from '../flows/harness';
import type { MessageReceipt, OutboundMessage } from '../../src/messaging';

class CapturingSender {
  readonly name = 'capture';
  readonly sent: OutboundMessage[] = [];
  async sendMessage(input: OutboundMessage): Promise<MessageReceipt> {
    this.sent.push(input);
    return {
      to: input.to,
      providerMessageId: `m_${this.sent.length}`,
      provider: this.name,
      sentAt: Date.now(),
    };
  }
  verifySignature(): boolean {
    return true;
  }
  verifyChallenge(): string | null {
    return null;
  }
  parseInbound(): never {
    throw new Error('not used');
  }
}

// ─── Twilio integration ────────────────────────────────────────────────────

describe('Webhook handler — Twilio', () => {
  const ACCOUNT_SID = 'AC' + 'a'.repeat(32);
  const AUTH_TOKEN = 'test-token';
  const WEBHOOK_URL = 'https://api.example.test/webhook';
  const WHATSAPP_FROM = 'whatsapp:+14155238886';

  function buildApp(): { app: express.Express; sender: CapturingSender } {
    const provider = new TwilioProvider({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      whatsappFrom: WHATSAPP_FROM,
      publicWebhookUrl: WEBHOOK_URL,
    });
    const sender = new CapturingSender();
    const dispatcher = new MessageDispatcher({
      sessionStore: new InMemorySessionStore({ ttlMs: 60_000 }),
      idempotencyStore: new InMemoryIdempotencyStore(),
      flowRegistry: FlowRegistry.default(),
      sender,
      client: new FakeBackendClient() as unknown as ConstructorParameters<typeof MessageDispatcher>[0]['client'],
      templates: new DefaultTemplates(),
    });
    const app = express();
    app.use(makeRouter({ provider, dispatcher }));
    return { app, sender };
  }

  function twilioSign(url: string, params: Record<string, string>, token: string): string {
    const sortedKeys = Object.keys(params).sort();
    const data = sortedKeys.reduce((acc, key) => acc + key + (params[key] ?? ''), url);
    return createHmac('sha1', token).update(data).digest('base64');
  }

  it('GET /webhook returns 404 for Twilio (no challenge handshake)', async () => {
    const { app } = buildApp();
    await request(app).get('/webhook').expect(404);
  });

  it('POST /webhook with valid signature processes the message and ACKs 200', async () => {
    const { app, sender } = buildApp();
    const params = {
      From: 'whatsapp:+2348031234567',
      To: WHATSAPP_FROM,
      Body: '1',
      MessageSid: 'SM' + 'a'.repeat(32),
    };
    const sig = twilioSign(WEBHOOK_URL, params, AUTH_TOKEN);

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Twilio-Signature', sig)
      .send(new URLSearchParams(params).toString())
      .expect(200);

    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0]!.to).toBe('+2348031234567');
  });

  it('POST /webhook with invalid signature returns 401, no processing', async () => {
    const { app, sender } = buildApp();
    const params = {
      From: 'whatsapp:+2348031234567',
      Body: '1',
      MessageSid: 'SM' + 'a'.repeat(32),
    };

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Twilio-Signature', 'totally-bogus-signature-blah')
      .send(new URLSearchParams(params).toString())
      .expect(401);

    expect(sender.sent.length).toBe(0);
  });

  it('POST /webhook without signature header returns 401', async () => {
    const { app } = buildApp();
    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('From=whatsapp:%2B2348031234567&Body=1&MessageSid=SM' + 'a'.repeat(32))
      .expect(401);
  });

  it('POST /webhook with status callback (no Body) ACKs 200, no processing', async () => {
    const { app, sender } = buildApp();
    const params = {
      MessageStatus: 'delivered',
      MessageSid: 'SM' + 'a'.repeat(32),
    };
    const sig = twilioSign(WEBHOOK_URL, params, AUTH_TOKEN);

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Twilio-Signature', sig)
      .send(new URLSearchParams(params).toString())
      .expect(200);

    expect(sender.sent.length).toBe(0);
  });

  it('duplicate webhook delivery is processed once', async () => {
    const { app, sender } = buildApp();
    const params = {
      From: 'whatsapp:+2348031234567',
      To: WHATSAPP_FROM,
      Body: '1',
      MessageSid: 'SM' + 'b'.repeat(32),
    };
    const sig = twilioSign(WEBHOOK_URL, params, AUTH_TOKEN);

    const send = (): request.Test =>
      request(app)
        .post('/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('X-Twilio-Signature', sig)
        .send(new URLSearchParams(params).toString());

    await send().expect(200);
    await send().expect(200);
    await send().expect(200);

    // Only the first call was processed
    expect(sender.sent.length).toBe(1);
  });

  it('GET /health returns 200', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─── WhatsApp Cloud integration ────────────────────────────────────────────

describe('Webhook handler — WhatsApp Cloud', () => {
  const APP_SECRET = 'app-secret';
  const VERIFY_TOKEN = 'verify-tok';

  function buildApp(): { app: express.Express; sender: CapturingSender } {
    const provider = new WhatsAppCloudProvider({
      accessToken: 'EAA',
      phoneNumberId: '123',
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
    });
    const sender = new CapturingSender();
    const dispatcher = new MessageDispatcher({
      sessionStore: new InMemorySessionStore({ ttlMs: 60_000 }),
      idempotencyStore: new InMemoryIdempotencyStore(),
      flowRegistry: FlowRegistry.default(),
      sender,
      client: new FakeBackendClient() as unknown as ConstructorParameters<typeof MessageDispatcher>[0]['client'],
      templates: new DefaultTemplates(),
    });
    const app = express();
    app.use(makeRouter({ provider, dispatcher }));
    return { app, sender };
  }

  it('GET /webhook with correct verify_token echoes the challenge', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '987654',
      })
      .expect(200);
    expect(res.text).toBe('987654');
  });

  it('GET /webhook with wrong verify_token returns 404', async () => {
    const { app } = buildApp();
    await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'WRONG',
        'hub.challenge': '987654',
      })
      .expect(404);
  });

  it('POST /webhook with valid signature processes the inbound', async () => {
    const { app, sender } = buildApp();
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '2348031234567',
                    id: 'wamid.in.test',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: '1' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .send(body)
      .expect(200);

    expect(sender.sent.length).toBe(1);
  });

  it('POST /webhook with tampered body returns 401', async () => {
    const { app } = buildApp();
    const payload = { entry: [] };
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');

    // Tamper after signing
    const tampered = body + ' ';

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .send(tampered)
      .expect(401);
  });
});
