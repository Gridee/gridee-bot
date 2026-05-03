import type { Request } from 'express';
import type { InboundMessage, MessageReceipt, OutboundMessage } from './types';

/**
 * Outbound-only contract.
 *
 * This is the surface the BACKEND uses for push notifications. The backend
 * never receives inbound webhooks (that's the bot's job), so we narrow the
 * interface to prevent accidental coupling.
 */
export interface IMessageSender {
  readonly name: string;

  /**
   * Send a message. Always pipes through `safeMessage()` internally — callers
   * pass raw text, the implementation handles truncation.
   *
   * Throws:
   *   - OutboundRejectedError on permanent 4xx failures (bad number, blocked, etc.)
   *   - TransientSendError on 5xx / network errors (caller may retry)
   */
  sendMessage(input: OutboundMessage): Promise<MessageReceipt>;
}

/**
 * Full contract — outbound + inbound webhook handling.
 *
 * The BOT uses this. Each provider (Twilio, WhatsApp Cloud, AT) implements
 * its own inbound shape, signature scheme, and challenge protocol so the
 * webhook handler stays provider-agnostic.
 */
export interface IMessagingProvider extends IMessageSender {
  /**
   * Verify the inbound webhook signature.
   *
   * Each provider has its own signature scheme:
   *   - Twilio: HMAC-SHA1 in `X-Twilio-Signature` header, validated against
   *     the full URL + sorted body params.
   *   - WhatsApp Cloud (Meta): HMAC-SHA256 in `X-Hub-Signature-256`.
   *   - Africa's Talking: shared-secret token in body, no per-message HMAC.
   *
   * IMPORTANT: implementations must use timing-safe comparison.
   *
   * Returns true if the signature is valid; false if not. Never throws —
   * the caller decides what to do with `false` (return 401).
   */
  verifySignature(req: Request, rawBody: Buffer): boolean;

  /**
   * For providers that do a GET-based verification handshake (Meta's
   * `hub.challenge` flow). Returns the string to echo back, or null if this
   * request isn't a verification challenge.
   *
   * Providers without a challenge step (Twilio, AT) always return null.
   */
  verifyChallenge(req: Request): string | null;

  /**
   * Parse a verified inbound webhook payload into a normalized InboundMessage.
   * Called AFTER `verifySignature` returns true.
   *
   * Throws InboundParseError if the payload doesn't match the expected shape.
   * Returns null for valid-but-not-a-message events (status callbacks, read
   * receipts, etc.) — caller should ack 200 and move on.
   */
  parseInbound(rawBody: Buffer, contentType: string): InboundMessage | null;
}
