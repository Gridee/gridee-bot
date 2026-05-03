import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
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

export interface WhatsAppCloudProviderOptions {
  /** Meta Graph API access token (long-lived). REQUIRED for outbound. */
  accessToken: string;
  /** Phone number ID from the Meta dashboard. REQUIRED for outbound. */
  phoneNumberId: string;
  /**
   * App secret from the Meta dashboard. REQUIRED for inbound (used in
   * X-Hub-Signature-256 verification). Outbound-only consumers can omit.
   */
  appSecret?: string;
  /**
   * The verify token YOU set in the Meta webhook config. REQUIRED for inbound
   * (used in the GET challenge handshake). Outbound-only consumers can omit.
   */
  verifyToken?: string;
  /** Override for testing. Default: https://graph.facebook.com/v22.0 */
  graphApiBase?: string;
  /** Optional fetch override for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * WhatsApp Cloud API provider (Meta direct).
 *
 * Outbound: POST https://graph.facebook.com/v22.0/{phoneNumberId}/messages
 *           with Authorization: Bearer {accessToken}
 * Inbound:  Meta POSTs JSON. Signature is HMAC-SHA256(appSecret, rawBody),
 *           hex-encoded, in X-Hub-Signature-256 header (prefixed "sha256=").
 * Verify:   Meta does a one-time GET with hub.mode=subscribe + hub.challenge.
 */
export class WhatsAppCloudProvider implements IMessagingProvider {
  readonly name = 'whatsapp_cloud';
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly appSecret: string | null;
  private readonly verifyToken: string | null;
  private readonly graphApiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WhatsAppCloudProviderOptions) {
    if (!opts.accessToken) throw new Error('WhatsAppCloud accessToken required');
    if (!opts.phoneNumberId) throw new Error('WhatsAppCloud phoneNumberId required');

    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.appSecret = opts.appSecret ?? null;
    this.verifyToken = opts.verifyToken ?? null;
    this.graphApiBase = opts.graphApiBase ?? 'https://graph.facebook.com/v22.0';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendMessage(input: OutboundMessage): Promise<MessageReceipt> {
    const body = safeMessage(input.text);
    const url = `${this.graphApiBase}/${this.phoneNumberId}/messages`;

    // E.164 to Meta's expected format: drop the leading +
    const recipient = input.to.startsWith('+') ? input.to.slice(1) : input.to;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'text',
          text: { body },
        }),
      });
    } catch (err) {
      throw new TransientSendError(`WhatsApp Cloud network error: ${(err as Error).message}`, err);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status >= 400 && response.status < 500) {
        throw new OutboundRejectedError(
          `WhatsApp Cloud rejected: ${response.status} ${errText}`,
          response.status,
        );
      }
      throw new TransientSendError(`WhatsApp Cloud transient: ${response.status} ${errText}`);
    }

    const data = (await response.json()) as { messages?: Array<{ id?: string }> };
    const id = data.messages?.[0]?.id;
    if (!id) {
      throw new TransientSendError('WhatsApp Cloud response missing message id');
    }

    return {
      to: input.to,
      providerMessageId: id,
      provider: this.name,
      sentAt: Date.now(),
    };
  }

  verifySignature(req: Request, rawBody: Buffer): boolean {
    if (this.appSecret === null) {
      throw new Error(
        'WhatsAppCloudProvider: cannot verify signatures — appSecret was not provided. ' +
          'This provider was instantiated for outbound-only use.',
      );
    }
    const header = req.header('x-hub-signature-256');
    if (!header || !header.startsWith('sha256=')) return false;

    const provided = header.slice('sha256='.length);
    const expected = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');

    // Length check first — timingSafeEqual throws on mismatched lengths
    if (provided.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'WhatsApp Cloud signature compare failed');
      return false;
    }
  }

  verifyChallenge(req: Request): string | null {
    if (this.verifyToken === null) {
      throw new Error(
        'WhatsAppCloudProvider: cannot handle challenge — verifyToken was not provided. ' +
          'This provider was instantiated for outbound-only use.',
      );
    }
    if (req.method !== 'GET') return null;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && typeof token === 'string' && token === this.verifyToken) {
      return typeof challenge === 'string' ? challenge : null;
    }
    return null;
  }

  parseInbound(rawBody: Buffer, contentType: string): InboundMessage | null {
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new InboundParseError(`WhatsApp Cloud inbound expected JSON, got ${contentType}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      throw new InboundParseError(`WhatsApp Cloud inbound JSON parse failed: ${(err as Error).message}`);
    }

    // Meta payload shape: entry[].changes[].value.messages[]
    // Status updates come through the same endpoint with `value.statuses` instead.
    const entry = (payload as { entry?: Array<unknown> }).entry?.[0] as
      | { changes?: Array<{ value?: { messages?: Array<MetaMessage> } }> }
      | undefined;
    const change = entry?.changes?.[0];
    const messages = change?.value?.messages;
    if (!messages || messages.length === 0) {
      // Status update or other event — not an inbound message
      return null;
    }

    const msg = messages[0]!;
    if (msg.type !== 'text') {
      // Non-text inbound (image, sticker, etc.) — out of scope for MVP.
      // Return null so caller acks 200 instead of erroring.
      return null;
    }

    const phone = Phone.tryOf(msg.from.startsWith('+') ? msg.from : `+${msg.from}`);
    if (!phone) throw new InboundParseError(`WhatsApp Cloud From is not E.164: ${msg.from}`);

    return {
      from: phone,
      text: msg.text?.body ?? '',
      providerMessageId: msg.id,
      receivedAt: Number(msg.timestamp) * 1000 || Date.now(),
      provider: this.name,
    };
  }
}

interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}
