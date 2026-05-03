import type { Phone } from '../lib/phone';
import type { SessionState } from '../session/types';
import type { BackendClient } from '../client';
import type { ITemplates } from '../templates';
import type { logger } from '../lib/logger';

/**
 * Commands are stateless: take a message, return a reply.
 *
 * Unlike flows, commands don't change `session.step` and don't need
 * patches. They fire in idle authenticated states (LANDLORD_AUTHENTICATED,
 * TENANT_AUTHENTICATED) and AWAITING_PAYMENT (where BuyFlow returns
 * passthrough for any non-payment-related message).
 *
 * Three reply modes:
 *   - 'reply'        — send the text, leave session unchanged
 *   - 'reply+patch'  — send the text, apply a session patch (e.g. start a
 *                      flow: WITHDRAW or REMOVE_TENANT). The dispatcher
 *                      treats this same as a flow's `advance`.
 *   - 'unhandled'    — this command doesn't apply to this message — try
 *                      the next command in the registry
 */
export type CommandResult =
  | { kind: 'reply'; text: string }
  | { kind: 'reply+patch'; text: string; patch: import('../flows').SessionPatch }
  | { kind: 'unhandled' };

export interface CommandContext {
  phone: Phone;
  session: SessionState;
  client: BackendClient;
  templates: ITemplates;
  log: typeof logger;
}

export interface ICommand {
  /** Unique command id, e.g. 'BALANCE'. Used in logs. */
  readonly id: string;

  /**
   * Decide whether this command handles the message + session combination.
   *
   * The registry calls this in registration order; first match wins.
   * Use the session.role and session.step to scope role-specific commands.
   */
  matches(message: string, session: SessionState): boolean;

  /**
   * Process the message. Returns a reply, optionally with a session patch.
   * MUST not throw — wrap backend calls in Result handling.
   */
  handle(ctx: CommandContext, message: string): Promise<CommandResult>;
}
