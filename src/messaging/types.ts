import { z } from 'zod';
import { Phone } from '../lib/phone';

// ─────────────────────────────────────────────────────────────────────────────
// InboundMessage — provider-agnostic shape after each provider parses its
// own webhook payload. The dispatcher never sees provider-specific shapes.
// ─────────────────────────────────────────────────────────────────────────────

export const InboundMessageSchema = z.object({
  /** E.164 sender. Each provider normalizes their own format to this. */
  from: Phone.schema,

  /** Plain text body. Media attachments are not supported in MVP. */
  text: z.string(),

  /**
   * Stable message ID from the provider. Used for inbound idempotency —
   * if we see the same ID twice (provider retried), skip processing.
   */
  providerMessageId: z.string().min(1),

  /** When the provider says the message arrived (ms since epoch). */
  receivedAt: z.number().int().nonnegative(),

  /** Which provider produced this. Useful for logs and per-provider metrics. */
  provider: z.string().min(1),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// OutboundMessage — what the dispatcher hands to the sender
// ─────────────────────────────────────────────────────────────────────────────

export interface OutboundMessage {
  to: Phone;
  text: string;
  /**
   * Optional Screen ID this message corresponds to. Stored on the receipt
   * so logs/metrics can correlate sends with the SCREENS.md taxonomy.
   * Not all sends have a screen (e.g. ad-hoc error replies).
   */
  screenId?: string;
}

export interface MessageReceipt {
  to: Phone;
  /** Provider's ID for the message we just sent — for delivery tracking. */
  providerMessageId: string;
  provider: string;
  /** When we received the provider's accept response (ms since epoch). */
  sentAt: number;
}
