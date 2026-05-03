import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AfricasTalkingProvider } from '../../src/messaging/providers/AfricasTalkingProvider';
import { InboundParseError, OutboundRejectedError } from '../../src/messaging/errors';

const SECRET = 'shared-webhook-secret';

function makeProvider(fetchImpl?: typeof fetch): AfricasTalkingProvider {
  return new AfricasTalkingProvider({
    apiKey: 'k',
    username: 'sandbox',
    senderId: '+254700000000',
    webhookSecret: SECRET,
    apiBase: 'https://chat.test',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

function makeReq(body: Record<string, unknown>): Request {
  return { body, method: 'POST' } as unknown as Request;
}

describe('AfricasTalkingProvider — verifySignature', () => {
  it('accepts the correct shared secret', () => {
    const provider = makeProvider();
    const req = makeReq({ secret: SECRET, from: '+2348031234567', text: 'hi' });
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const provider = makeProvider();
    const req = makeReq({ secret: 'wrong', from: '+2348031234567', text: 'hi' });
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(false);
  });

  it('rejects a missing secret', () => {
    const provider = makeProvider();
    const req = makeReq({ from: '+2348031234567', text: 'hi' });
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(false);
  });

  it('rejects a non-string secret (e.g. injected as number/object)', () => {
    const provider = makeProvider();
    expect(provider.verifySignature(makeReq({ secret: 12345 }), Buffer.alloc(0))).toBe(false);
    expect(provider.verifySignature(makeReq({ secret: { v: SECRET } }), Buffer.alloc(0))).toBe(false);
  });
});

describe('AfricasTalkingProvider — parseInbound', () => {
  it('parses a valid inbound', () => {
    const provider = makeProvider();
    const body = JSON.stringify({
      from: '+2348031234567',
      text: 'BALANCE',
      id: 'at-msg-1',
      timestamp: '2026-05-01T10:00:00Z',
    });
    const result = provider.parseInbound(Buffer.from(body), 'application/json');
    expect(result).not.toBeNull();
    expect(result!.from).toBe('+2348031234567');
    expect(result!.text).toBe('BALANCE');
    expect(result!.providerMessageId).toBe('at-msg-1');
  });

  it('returns null when text is missing (status callback)', () => {
    const provider = makeProvider();
    const body = JSON.stringify({ from: '+2348031234567', status: 'delivered' });
    expect(provider.parseInbound(Buffer.from(body), 'application/json')).toBeNull();
  });

  it('throws on non-E.164 from', () => {
    const provider = makeProvider();
    const body = JSON.stringify({ from: 'not-a-phone', text: 'hi' });
    expect(() => provider.parseInbound(Buffer.from(body), 'application/json')).toThrow(InboundParseError);
  });
});

describe('AfricasTalkingProvider — sendMessage', () => {
  it('returns OutboundRejectedError on 4xx', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    await expect(
      provider.sendMessage({
        to: '+2348031234567' as Parameters<typeof provider.sendMessage>[0]['to'],
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(OutboundRejectedError);
  });

  it('synthesizes a message id when AT response omits one', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'queued' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    const receipt = await provider.sendMessage({
      to: '+2348031234567' as Parameters<typeof provider.sendMessage>[0]['to'],
      text: 'hi',
    });
    expect(receipt.providerMessageId).toMatch(/^at_/);
  });
});
