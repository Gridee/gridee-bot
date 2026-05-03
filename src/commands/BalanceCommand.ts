import type { ICommand, CommandContext, CommandResult } from './ICommand';
import type { SessionState } from '../session/types';

/**
 * BALANCE — tenant-only. Calls /api/tenants/me/balance.
 *
 * The backend returns balance in GRD (already converted from mGRD), the
 * estimated days-of-power-remaining, and the current state (CONNECTED/CUTOFF).
 */
export class BalanceCommand implements ICommand {
  readonly id = 'BALANCE';

  matches(message: string, session: SessionState): boolean {
    return (
      session.role === 'tenant' &&
      message.trim().toUpperCase() === 'BALANCE'
    );
  }

  async handle(ctx: CommandContext, _message: string): Promise<CommandResult> {
    if (!ctx.session.jwt) {
      return { kind: 'reply', text: ctx.templates.errorAuthExpired() };
    }
    const result = await ctx.client.getBalance(ctx.session.jwt);
    if (!result.ok) {
      ctx.log.warn(
        { err: result.error.message },
        'BALANCE command: backend call failed',
      );
      return { kind: 'reply', text: ctx.templates.errorBackendUnavailable() };
    }
    return {
      kind: 'reply',
      text: ctx.templates.balanceView({
        balanceGrd: result.value.balanceGrd,
        estimatedDaysRemaining: result.value.estimatedDaysRemaining,
        status: result.value.status,
      }),
    };
  }
}
