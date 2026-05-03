import type { ICommand, CommandContext, CommandResult } from './ICommand';
import type { SessionState } from '../session/types';

/**
 * HISTORY — tenant-only. Calls /api/tenants/me/history?limit=10.
 */
export class HistoryCommand implements ICommand {
  readonly id = 'HISTORY';

  matches(message: string, session: SessionState): boolean {
    return (
      session.role === 'tenant' &&
      message.trim().toUpperCase() === 'HISTORY'
    );
  }

  async handle(ctx: CommandContext, _message: string): Promise<CommandResult> {
    if (!ctx.session.jwt) {
      return { kind: 'reply', text: ctx.templates.errorAuthExpired() };
    }
    const result = await ctx.client.getHistory(ctx.session.jwt, 10);
    if (!result.ok) {
      ctx.log.warn(
        { err: result.error.message },
        'HISTORY command: backend call failed',
      );
      return { kind: 'reply', text: ctx.templates.errorBackendUnavailable() };
    }
    if (result.value.transactions.length === 0) {
      return { kind: 'reply', text: ctx.templates.historyEmpty() };
    }
    return {
      kind: 'reply',
      text: ctx.templates.historyView({
        entries: result.value.transactions.map((tx) => ({
          kind: tx.kind,
          amountGrd: tx.amountGrd,
          amountNgn: tx.amountNgn,
          balanceAfterGrd: tx.balanceAfterGrd,
          at: tx.at,
        })),
      }),
    };
  }
}
