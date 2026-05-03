import type { ICommand, CommandContext, CommandResult } from './ICommand';
import type { SessionState } from '../session/types';

/**
 * MENU / HOME — return the user to the idle authenticated step from anywhere.
 *
 * The most common use case: after a payment confirms, the user's session is
 * still at AWAITING_PAYMENT (the backend has no channel to advance the bot's
 * session). The user types MENU to return to TENANT_AUTHENTICATED, where
 * the BUY shortcut fires and HELP / BALANCE / HISTORY all work normally.
 *
 * Also useful when a user gets confused mid-onboarding or mid-buy. MENU
 * resets the step back to a known-good state without losing their auth
 * (jwt, userId, role are preserved). For unauthenticated users (no role),
 * MENU returns to WELCOME_ROLE_SELECT so they can restart onboarding.
 *
 * Patch semantics:
 *   - clearData: true   — wipe any partial-flow data (e.g. half-typed phone
 *                          number, captured BUY amount) so the next message
 *                          starts fresh
 *   - step: <idle>      — TENANT_AUTHENTICATED for tenants,
 *                          LANDLORD_AUTHENTICATED for landlords,
 *                          WELCOME_ROLE_SELECT for unauthenticated
 */
export class MenuCommand implements ICommand {
  readonly id = 'MENU';

  matches(message: string, _session: SessionState): boolean {
    const m = message.trim().toUpperCase();
    return m === 'MENU' || m === 'HOME';
  }

  async handle(ctx: CommandContext, _message: string): Promise<CommandResult> {
    if (ctx.session.role === 'tenant') {
      // If already at TENANT_AUTHENTICATED, this is a confirming no-op.
      // Either way the patch is harmless and the reply guides the user.
      return {
        kind: 'reply+patch',
        text: ctx.templates.menuReturnTenant(),
        patch: { step: 'TENANT_AUTHENTICATED', clearData: true },
      };
    }
    if (ctx.session.role === 'landlord') {
      return {
        kind: 'reply+patch',
        text: ctx.templates.menuReturnLandlord(),
        patch: { step: 'LANDLORD_AUTHENTICATED', clearData: true },
      };
    }
    // Unauthenticated — restart onboarding from the welcome screen
    return {
      kind: 'reply+patch',
      text: ctx.templates.menuReturnUnauthenticated(),
      patch: { step: 'WELCOME_ROLE_SELECT', clearData: true },
    };
  }
}
