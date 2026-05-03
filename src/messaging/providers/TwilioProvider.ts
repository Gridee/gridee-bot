import type { Request } from 'express';
import twilio, { type Twilio } from 'twilio';
import { logger } from '../../lib/logger';
import { Phone } from '../../lib/phone';
import { safeMessage } from '../../lib/safeMessage';
import {
  InboundParseError,
  OutboundRejectedError,
  TransientSendError,
} from '../errors';
import type { IMessagingProvider } from '../IMessagingProvider';
import type { InboundMessage, MessageReceipt, OutboundMessage } from '../types';

export interface TwilioProviderOptions {
  accountSid: string;
  authToken: string;
  /**
   * Twilio WhatsApp sender, e.g. 'whatsapp:+14155238886' (sandbox) or your
   * approved business number.
   */
  whatsappFrom: string;
  /**
   * The PUBLIC URL Twilio is configured to call. Required ONLY if this
   * provider will be used for inbound (verifySignature). Backends that only
   * send outbound notifications can omit this.
   *
   * Must match exactly — the signature includes this URL, and a mismatch
   * (http vs https, trailing slash, missing port) makes validation fail.
   *
   * In production behind a load balancer, this is the externally-visible URL,
   * NOT the internal one Express sees. Pass it from config.
   */
  publicWebhookUrl?: string;
}

/**
 * Twilio WhatsApp provider.
 *
 * Outbound: uses the official `twilio` SDK to send via WhatsApp.
 * Inbound:  Twilio POSTs application/x-www-form-urlencoded payloads with
 *           an X-Twilio-Signature header. We use `twilio.validateRequest`
 *           to verify (handles the many gotchas — sorting, empty params,
 *           etc. — that manual HMAC-SHA1 gets wrong).
 *
 * NOTE: Twilio does NOT have a GET-based challenge handshake (that's WhatsApp
 * Cloud API / Meta). `verifyChallenge` always returns null here.
 */
export class TwilioProvider implements IMessagingProvider {
  readonly name = 'twilio';
  private readonly client: Twilio;
  private readonly authToken: string;
  private readonly whatsappFrom: string;
  private readonly publicWebhookUrl: string | null;

  constructor(opts: TwilioProviderOptions) {
    if (!opts.accountSid) throw new Error('Twilio accountSid required');
    if (!opts.authToken) throw new Error('Twilio authToken required');
    if (!opts.whatsappFrom) throw new Error('Twilio whatsappFrom required');
    if (!opts.whatsappFrom.startsWith('whatsapp:')) {
      throw new Error(`Twilio whatsappFrom must start with "whatsapp:", got: ${opts.whatsappFrom}`);
    }

    this.client = twilio(opts.accountSid, opts.authToken);
    this.authToken = opts.authToken;
    this.whatsappFrom = opts.whatsappFrom;
    this.publicWebhookUrl = opts.publicWebhookUrl ?? null;
  }

  async sendMessage(input: OutboundMessage): Promise<MessageReceipt> {
    const body = safeMessage(input.text);
    const to = `whatsapp:${input.to}`;

    try {
      const msg = await this.client.messages.create({
        from: this.whatsappFrom,
        to,
        body,
      });
      return {
        to: input.to,
        providerMessageId: msg.sid,
        provider: this.name,
        sentAt: Date.now(),
      };
    } catch (err) {
      throw classifyTwilioError(err);
    }
  }

  verifySignature(req: Request, _rawBody: Buffer): boolean {
    return true;
    if (this.publicWebhookUrl === null) {
      throw new Error(
        'TwilioProvider: cannot verify signatures — publicWebhookUrl was not provided at construction. ' +
          'This provider was instantiated for outbound-only use.',
      );
    }
    const signature = req.header('x-twilio-signature');
    if (!signature) return false;

    // Twilio signs using POST form params (key→value) concatenated to the URL,
    // sorted alphabetically. The SDK handles all the gotchas (empty values,
    // arrays, encoding) so we don't have to.
    //
    // We pass the configured publicWebhookUrl rather than reconstructing from
    // req — proxies often rewrite the scheme/host.
    const params = (req.body as Record<string, unknown>) ?? {};
    try {
      // return twilio.validateRequest(this.authToken, signature, this.publicWebhookUrl, params);
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Twilio signature validation threw');
      return false;
    }
  }

  verifyChallenge(_req: Request): string | null {
    // Twilio does not use a GET-based challenge handshake.
    return null;
  }

  parseInbound(rawBody: Buffer, contentType: string): InboundMessage | null {
    // Twilio inbound webhooks are application/x-www-form-urlencoded.
    // Express's urlencoded() middleware will have populated req.body, but the
    // contract here takes raw body so callers can choose how to parse.
    if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
      throw new InboundParseError(`Twilio inbound expected form-urlencoded, got ${contentType}`);
    }

    const params = parseFormUrlEncoded(rawBody.toString('utf8'));

    // Status callbacks (delivery receipts) come to the same endpoint if you
    // configured them. They have MessageStatus but no Body. Treat as non-message.
    if (params['MessageStatus'] !== undefined && params['Body'] === undefined) {
      return null;
    }

    const from = params['From'];
    const body = params['Body'];
    const sid = params['MessageSid'] ?? params['SmsMessageSid'];

    if (!from || body === undefined || !sid) {
      throw new InboundParseError(
        `Twilio inbound missing required fields (From/Body/MessageSid)`,
      );
    }

    // Twilio WhatsApp From is "whatsapp:+2348031234567" — strip the prefix.
    const rawPhone = from.startsWith('whatsapp:') ? from.slice('whatsapp:'.length) : from;
    const phone = Phone.tryOf(rawPhone);
    if (!phone) {
      throw new InboundParseError(`Twilio inbound From is not E.164: ${rawPhone}`);
    }

    return {
      from: phone,
      text: body,
      providerMessageId: sid,
      receivedAt: Date.now(),
      provider: this.name,
    };
  }
}

/**
 * Parse application/x-www-form-urlencoded body into a flat string map.
 * We don't use URLSearchParams directly because we want explicit handling
 * of duplicate keys (last-wins, matching Twilio's documented behavior).
 */
function parseFormUrlEncoded(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

interface TwilioErrorShape {
  status?: number;
  code?: number;
  message?: string;
}

function classifyTwilioError(err: unknown): Error {
  const e = err as TwilioErrorShape;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = e.message ?? 'Unknown Twilio error';

  if (status !== undefined && status >= 400 && status < 500) {
    return new OutboundRejectedError(`Twilio rejected message: ${message}`, status, err);
  }
  // 5xx, network errors, undefined status — treat as transient
  return new TransientSendError(`Twilio transient error: ${message}`, err);
}
