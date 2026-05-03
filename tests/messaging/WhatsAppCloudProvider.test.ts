import { createHmac } from 'crypto';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  InboundParseError,
  OutboundRejectedError,
  TransientSendError,
} from '../../src/messaging/errors';
import { WhatsAppCloudProvider } from '../../src/messaging/providers/WhatsAppCloudProvider';

const APP_SECRET = 'app-secret-test';
const VERIFY_TOKEN = 'my-verify-token';

function makeProvider(fetchImpl?: typeof fetch): WhatsAppCloudProvider {
  return new WhatsAppCloudProvider({
    accessToken: 'EAAxxxxx',
    phoneNumberId: '1234567890',
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    graphApiBase: 'https://graph.facebook.test/v22.0',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

function makeReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): Request {
  return {
    method: opts.method ?? 'POST',
    query: opts.query ?? {},
    header(name: string): string | undefined {
      return opts.headers?.[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('WhatsAppCloudProvider — verifyChallenge', () => {
  it('returns the challenge when mode/token match', () => {
    const provider = makeProvider();
    const req = makeReq({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '12345' },
    });
    expect(provider.verifyChallenge(req)).toBe('12345');
  });

  it('returns null when token does not match', () => {
    const provider = makeProvider();
    const req = makeReq({
      method: 'GET',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' },
    });
    expect(provider.verifyChallenge(req)).toBeNull();
  });

  it('returns null on POST', () => {
    const provider = makeProvider();
    const req = makeReq({ method: 'POST' });
    expect(provider.verifyChallenge(req)).toBeNull();
  });

  it('returns null when mode is not subscribe', () => {
    const provider = makeProvider();
    const req = makeReq({
      method: 'GET',
      query: { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '12345' },
    });
    expect(provider.verifyChallenge(req)).toBeNull();
  });
});

describe('WhatsAppCloudProvider — verifySignature', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const provider = makeProvider();
    const body = Buffer.from('{"entry":[]}');
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const req = makeReq({ headers: { 'x-hub-signature-256': sig } });
    expect(provider.verifySignature(req, body)).toBe(true);
  });

  it('rejects when body is tampered', () => {
    const provider = makeProvider();
    const body = Buffer.from('{"entry":[]}');
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const req = makeReq({ headers: { 'x-hub-signature-256': sig } });
    expect(provider.verifySignature(req, Buffer.from('{"entry":[1]}'))).toBe(false);
  });

  it('rejects when signed with wrong secret', () => {
    const provider = makeProvider();
    const body = Buffer.from('{"entry":[]}');
    const wrongSig = 'sha256=' + createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    const req = makeReq({ headers: { 'x-hub-signature-256': wrongSig } });
    expect(provider.verifySignature(req, body)).toBe(false);
  });

  it('rejects missing header', () => {
    const provider = makeProvider();
    expect(provider.verifySignature(makeReq({}), Buffer.from('{}'))).toBe(false);
  });

  it('rejects header without sha256= prefix', () => {
    const provider = makeProvider();
    const body = Buffer.from('{}');
    const hex = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const req = makeReq({ headers: { 'x-hub-signature-256': hex } }); // no prefix
    expect(provider.verifySignature(req, body)).toBe(false);
  });
});

describe('WhatsAppCloudProvider — sendMessage', () => {
  it('POSTs to graph API and returns receipt', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    const receipt = await provider.sendMessage({
      to: '+2348031234567' as Parameters<typeof provider.sendMessage>[0]['to'],
      text: 'Hi',
    });

    expect(receipt.providerMessageId).toBe('wamid.123');
    expect(receipt.provider).toBe('whatsapp_cloud');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://graph.facebook.test/v22.0/1234567890/messages');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent.to).toBe('2348031234567'); // leading + stripped
    expect(sent.text.body).toBe('Hi');
  });

  it('throws OutboundRejectedError on 4xx', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 400 }));
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    await expect(
      provider.sendMessage({
        to: '+2348031234567' as Parameters<typeof provider.sendMessage>[0]['to'],
        text: 'Hi',
      }),
    ).rejects.toBeInstanceOf(OutboundRejectedError);
  });

  it('throws TransientSendError on 5xx', async () => {
    const fetchMock = vi.fn(async () => new Response('oops', { status: 503 }));
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    await expect(
      provider.sendMessage({
        to: '+2348031234567' as Parameters<typeof provider.sendMessage>[0]['to'],
        text: 'Hi',
      }),
    ).rejects.toBeInstanceOf(TransientSendError);
  });

  it('throws TransientSendError on network error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    await expect(
      provider.sendMessage({
        to: '+2348031234567' as Parameters<typeof provider.sendMessage>[0]['to'],
        text: 'Hi',
      }),
    ).rejects.toBeInstanceOf(TransientSendError);
  });

  it('truncates messages over 4096 chars', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'm' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    const long = 'x'.repeat(5000);
    await provider.sendMessage({
      to: '+2348031234567' as Parameters<typeof provider.sendMessage>[0]['to'],
      text: long,
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(call[1].body as string);
    expect(sent.text.body.length).toBe(4096);
    expect(sent.text.body.endsWith(' ...')).toBe(true);
  });
});

describe('WhatsAppCloudProvider — parseInbound', () => {
  function metaPayload(message: object): string {
    return JSON.stringify({
      entry: [{ changes: [{ value: { messages: [message] } }] }],
    });
  }

  it('parses a text message', () => {
    const provider = makeProvider();
    const raw = metaPayload({
      from: '2348031234567',
      id: 'wamid.in.123',
      timestamp: '1700000000',
      type: 'text',
      text: { body: 'BUY 5000' },
    });
    const result = provider.parseInbound(Buffer.from(raw), 'application/json');
    expect(result).not.toBeNull();
    expect(result!.from).toBe('+2348031234567');
    expect(result!.text).toBe('BUY 5000');
    expect(result!.providerMessageId).toBe('wamid.in.123');
    expect(result!.receivedAt).toBe(1700000000 * 1000);
  });

  it('returns null for non-text messages (image, sticker, etc.)', () => {
    const provider = makeProvider();
    const raw = metaPayload({
      from: '2348031234567',
      id: 'wamid.in.124',
      timestamp: '1700000000',
      type: 'image',
    });
    expect(provider.parseInbound(Buffer.from(raw), 'application/json')).toBeNull();
  });

  it('returns null for status updates (no messages array)', () => {
    const provider = makeProvider();
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }],
    });
    expect(provider.parseInbound(Buffer.from(raw), 'application/json')).toBeNull();
  });

  it('throws on wrong content type', () => {
    const provider = makeProvider();
    expect(() => provider.parseInbound(Buffer.from('hi'), 'text/plain')).toThrow(InboundParseError);
  });

  it('throws on invalid JSON', () => {
    const provider = makeProvider();
    expect(() => provider.parseInbound(Buffer.from('not json'), 'application/json')).toThrow(InboundParseError);
  });
});
