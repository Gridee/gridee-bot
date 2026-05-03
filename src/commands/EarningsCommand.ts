import type { ICommand, CommandContext, CommandResult } from './ICommand';
import type { SessionState } from '../session/types';

/**
 * EARNINGS — landlord-only. Shows pending and total earnings in NGN.
 */
export class EarningsCommand implements ICommand {
  readonly id = 'EARNINGS';

  matches(message: string, session: SessionState): boolean {
    return (
      session.role === 'landlord' &&
      message.trim().toUpperCase() === 'EARNINGS'
    );
  }

  async handle(ctx: CommandContext, _message: string): Promise<CommandResult> {
    if (!ctx.session.jwt) {
      return { kind: 'reply', text: ctx.templates.errorAuthExpired() };
    }
    const result = await ctx.client.getEarnings(ctx.session.jwt);
    if (!result.ok) {
      ctx.log.warn(
        { err: result.error.message },
        'EARNINGS command: backend call failed',
      );
      return { kind: 'reply', text: ctx.templates.errorBackendUnavailable() };
    }
    return {
      kind: 'reply',
      text: ctx.templates.earningsView({
        pendingNgn: result.value.pendingNgn,
        totalEarnedNgn: result.value.totalEarnedNgn,
      }),
    };
  }
}
