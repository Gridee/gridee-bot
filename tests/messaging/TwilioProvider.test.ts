import { createHmac } from 'crypto';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { Phone } from '../../src/lib/phone';
import { InboundParseError } from '../../src/messaging/errors';
import { TwilioProvider } from '../../src/messaging/providers/TwilioProvider';

const ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const AUTH_TOKEN = 'test-auth-token-secret';
const WHATSAPP_FROM = 'whatsapp:+14155238886';
const PUBLIC_WEBHOOK_URL = 'https://api.example.com/webhook';

function makeProvider(): TwilioProvider {
  return new TwilioProvider({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    whatsappFrom: WHATSAPP_FROM,
    publicWebhookUrl: PUBLIC_WEBHOOK_URL,
  });
}

/**
 * Replicate Twilio's signing algorithm so we can produce valid signatures
 * for tests. This MUST match Twilio's published spec exactly:
 *   sort POST params alphabetically, append key+value to URL,
 *   HMAC-SHA1 with auth token, base64.
 */
function twilioSign(url: string, params: Record<string, string>, authToken: string): string {
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

function makeReq(headers: Record<string, string>, body: Record<string, string>): Request {
  return {
    method: 'POST',
    body,
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('TwilioProvider — constructor', () => {
  it('throws if whatsappFrom does not start with "whatsapp:"', () => {
    expect(
      () =>
        new TwilioProvider({
          accountSid: ACCOUNT_SID,
          authToken: AUTH_TOKEN,
          whatsappFrom: '+14155238886', // missing prefix
          publicWebhookUrl: PUBLIC_WEBHOOK_URL,
        }),
    ).toThrow(/whatsapp:/);
  });
});

describe('TwilioProvider — verifySignature', () => {
  const params = {
    From: 'whatsapp:+2348031234567',
    To: WHATSAPP_FROM,
    Body: 'Hello',
    MessageSid: 'SM' + 'a'.repeat(32),
  };

  it('accepts a valid signature', () => {
    const provider = makeProvider();
    const sig = twilioSign(PUBLIC_WEBHOOK_URL, params, AUTH_TOKEN);
    const req = makeReq({ 'x-twilio-signature': sig }, params);
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const provider = makeProvider();
    const sig = twilioSign(PUBLIC_WEBHOOK_URL, params, AUTH_TOKEN);
    const tampered = { ...params, Body: 'Hello (modified)' };
    const req = makeReq({ 'x-twilio-signature': sig }, tampered);
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const provider = makeProvider();
    const req = makeReq({}, params);
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(false);
  });

  it('rejects a signature signed with a different token', () => {
    const provider = makeProvider();
    const wrongSig = twilioSign(PUBLIC_WEBHOOK_URL, params, 'different-token');
    const req = makeReq({ 'x-twilio-signature': wrongSig }, params);
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(false);
  });

  it('rejects a signature for a different URL', () => {
    const provider = makeProvider();
    const wrongUrlSig = twilioSign('https://api.example.com/different', params, AUTH_TOKEN);
    const req = makeReq({ 'x-twilio-signature': wrongUrlSig }, params);
    expect(provider.verifySignature(req, Buffer.alloc(0))).toBe(false);
  });
});

describe('TwilioProvider — verifyChallenge', () => {
  it('always returns null (Twilio has no challenge handshake)', () => {
    const provider = makeProvider();
    expect(provider.verifyChallenge({ method: 'GET' } as Request)).toBeNull();
  });
});

describe('TwilioProvider — parseInbound', () => {
  it('parses a valid inbound message', () => {
    const provider = makeProvider();
    const body = new URLSearchParams({
      From: 'whatsapp:+2348031234567',
      To: WHATSAPP_FROM,
      Body: 'TOPUP 5000',
      MessageSid: 'SM' + 'a'.repeat(32),
    }).toString();

    const result = provider.parseInbound(Buffer.from(body), 'application/x-www-form-urlencoded');
    expect(result).not.toBeNull();
    expect(result!.from).toBe('+2348031234567');
    expect(result!.text).toBe('TOPUP 5000');
    expect(result!.providerMessageId).toBe('SM' + 'a'.repeat(32));
    expect(result!.provider).toBe('twilio');
  });

  it('returns null for status callbacks (no Body, has MessageStatus)', () => {
    const provider = makeProvider();
    const body = new URLSearchParams({
      MessageStatus: 'delivered',
      MessageSid: 'SM' + 'a'.repeat(32),
    }).toString();

    expect(provider.parseInbound(Buffer.from(body), 'application/x-www-form-urlencoded')).toBeNull();
  });

  it('throws InboundParseError on wrong content type', () => {
    const provider = makeProvider();
    expect(() => provider.parseInbound(Buffer.from('{}'), 'application/json')).toThrow(InboundParseError);
  });

  it('throws InboundParseError when From is not E.164', () => {
    const provider = makeProvider();
    const body = new URLSearchParams({
      From: 'whatsapp:not-a-phone',
      Body: 'hi',
      MessageSid: 'SM' + 'a'.repeat(32),
    }).toString();

    expect(() => provider.parseInbound(Buffer.from(body), 'application/x-www-form-urlencoded')).toThrow(
      InboundParseError,
    );
  });

  it('throws InboundParseError when required fields are missing', () => {
    const provider = makeProvider();
    const body = new URLSearchParams({ Body: 'hi' }).toString(); // no From, no MessageSid
    expect(() => provider.parseInbound(Buffer.from(body), 'application/x-www-form-urlencoded')).toThrow(
      InboundParseError,
    );
  });

  it('handles empty Body (e.g. a message containing only an emoji that strips to empty)', () => {
    const provider = makeProvider();
    const body = new URLSearchParams({
      From: 'whatsapp:+2348031234567',
      Body: '',
      MessageSid: 'SM' + 'a'.repeat(32),
    }).toString();
    const result = provider.parseInbound(Buffer.from(body), 'application/x-www-form-urlencoded');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('');
  });

  it('uses Phone.tryOf to brand the phone (verified by type narrowing)', () => {
    const provider = makeProvider();
    const body = new URLSearchParams({
      From: 'whatsapp:+2348031234567',
      Body: 'hi',
      MessageSid: 'SM' + 'a'.repeat(32),
    }).toString();
    const result = provider.parseInbound(Buffer.from(body), 'application/x-www-form-urlencoded')!;
    // result.from is typed as Phone — passing it to a Phone-only function is the test
    const echoed: ReturnType<typeof Phone.of> = result.from;
    expect(echoed).toBe('+2348031234567');
  });
});
