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

export interface AfricasTalkingProviderOptions {
  apiKey: string;
  username: string;
  /** WhatsApp sender ID configured in the AT dashboard. */
  senderId: string;
  /**
   * Shared secret AT will include in webhook payloads. REQUIRED for inbound
   * (used in verifySignature). Outbound-only consumers can omit.
   *
   * AT does not sign per-message; you compare a known token instead.
   */
  webhookSecret?: string;
  /** Override for testing. */
  apiBase?: string;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

/**
 * Africa's Talking WhatsApp/SMS provider.
 *
 * Note: AT does NOT use HMAC signing. Their webhooks include a shared-secret
 * token in the body. This is weaker than HMAC — anyone with the token can
 * forge requests — so we additionally:
 *   1. Compare the secret in constant time
 *   2. Recommend the webhook endpoint be IP-whitelisted to AT's egress IPs
 *      at the proxy/firewall level
 */
export class AfricasTalkingProvider implements IMessagingProvider {
  readonly name = 'africas_talking';
  private readonly apiKey: string;
  private readonly username: string;
  private readonly senderId: string;
  private readonly webhookSecret: string | null;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AfricasTalkingProviderOptions) {
    if (!opts.apiKey) throw new Error('AT apiKey required');
    if (!opts.username) throw new Error('AT username required');
    if (!opts.senderId) throw new Error('AT senderId required');

    this.apiKey = opts.apiKey;
    this.username = opts.username;
    this.senderId = opts.senderId;
    this.webhookSecret = opts.webhookSecret ?? null;
    this.apiBase = opts.apiBase ?? 'https://chat.africastalking.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendMessage(input: OutboundMessage): Promise<MessageReceipt> {
    const body = safeMessage(input.text);
    const url = `${this.apiBase}/whatsapp/message/send`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          apiKey: this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          username: this.username,
          waNumber: this.senderId,
          phoneNumber: input.to,
          body: { text: body },
        }),
      });
    } catch (err) {
      throw new TransientSendError(`AT network error: ${(err as Error).message}`, err);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status >= 400 && response.status < 500) {
        throw new OutboundRejectedError(`AT rejected: ${response.status} ${errText}`, response.status);
      }
      throw new TransientSendError(`AT transient: ${response.status} ${errText}`);
    }

    const data = (await response.json().catch(() => ({}))) as { messageId?: string; status?: string };
    const id = data.messageId ?? `at_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    return {
      to: input.to,
      providerMessageId: id,
      provider: this.name,
      sentAt: Date.now(),
    };
  }

  verifySignature(req: Request, _rawBody: Buffer): boolean {
    if (this.webhookSecret === null) {
      throw new Error(
        'AfricasTalkingProvider: cannot verify signatures — webhookSecret was not provided. ' +
          'This provider was instantiated for outbound-only use.',
      );
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const provided = typeof body['secret'] === 'string' ? (body['secret'] as string) : null;
    if (!provided) return false;
    return constantTimeEquals(provided, this.webhookSecret);
  }

  verifyChallenge(_req: Request): string | null {
    return null;
  }

  parseInbound(rawBody: Buffer, contentType: string): InboundMessage | null {
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new InboundParseError(`AT inbound expected JSON, got ${contentType}`);
    }
    let payload: AfricasTalkingInbound;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as AfricasTalkingInbound;
    } catch (err) {
      throw new InboundParseError(`AT JSON parse failed: ${(err as Error).message}`);
    }

    if (!payload.text || !payload.from) {
      // Status callbacks lack one of these
      return null;
    }

    const phone = Phone.tryOf(payload.from);
    if (!phone) {
      logger.warn({ from: payload.from }, 'AT inbound From not E.164');
      throw new InboundParseError(`AT From is not E.164: ${payload.from}`);
    }

    return {
      from: phone,
      text: payload.text,
      providerMessageId: payload.id ?? `at_in_${Date.now()}`,
      receivedAt: payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now(),
      provider: this.name,
    };
  }
}

interface AfricasTalkingInbound {
  from?: string;
  text?: string;
  id?: string;
  timestamp?: string;
}

/** Constant-time string comparison without leaking length differences. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
