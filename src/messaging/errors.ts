import { GrideeError } from '../lib/errors';

/** Generic messaging error — connection, API failure, parse error. */
export class MessagingError extends GrideeError {}

/** Webhook signature did not match. ALWAYS treat as 401, never process. */
export class SignatureVerificationError extends MessagingError {}

/** Webhook payload structure was unexpected. */
export class InboundParseError extends MessagingError {}

/** The provider rejected the outbound message (4xx response). */
export class OutboundRejectedError extends MessagingError {
  constructor(message: string, public readonly providerStatus?: number, cause?: unknown) {
    super(message, cause);
  }
}

/** Transient send failure — retry may succeed. */
export class TransientSendError extends MessagingError {}
