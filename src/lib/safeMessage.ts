/**
 * Truncate a message to fit within WhatsApp's 4096-character limit.
 *
 * Per SCREENS.md, all outbound messages MUST go through this helper to
 * prevent provider rejections. We wrap at the sender boundary (inside the
 * messaging provider's sendMessage), not at every call site, so it can never
 * be forgotten.
 *
 * Strategy: if too long, keep the first (limit - 4) chars and append " ...".
 * The trailing space lets it render cleanly in clients that don't auto-space
 * around ellipses.
 */
const WHATSAPP_MAX = 4096;
const ELLIPSIS = ' ...';

export function safeMessage(text: string, max: number = WHATSAPP_MAX): string {
  if (text.length <= max) return text;
  return text.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}
