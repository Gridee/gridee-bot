import type { ICommand, CommandContext, CommandResult } from './ICommand';
import type { SessionState } from '../session/types';

/**
 * MY_PROPERTIES — landlord-only. Lists the landlord's properties.
 *
 * Accepts both `MY_PROPERTIES` and `PROPERTIES` for ergonomics.
 */
export class MyPropertiesCommand implements ICommand {
  readonly id = 'MY_PROPERTIES';

  matches(message: string, session: SessionState): boolean {
    if (session.role !== 'landlord') return false;
    const m = message.trim().toUpperCase();
    return m === 'MY_PROPERTIES' || m === 'MY PROPERTIES' || m === 'PROPERTIES';
  }

  async handle(ctx: CommandContext, _message: string): Promise<CommandResult> {
    if (!ctx.session.jwt) {
      return { kind: 'reply', text: ctx.templates.errorAuthExpired() };
    }
    const result = await ctx.client.listProperties(ctx.session.jwt);
    if (!result.ok) {
      ctx.log.warn(
        { err: result.error.message },
        'MY_PROPERTIES command: backend call failed',
      );
      return { kind: 'reply', text: ctx.templates.errorBackendUnavailable() };
    }
    if (result.value.properties.length === 0) {
      return { kind: 'reply', text: ctx.templates.myPropertiesEmpty() };
    }
    return {
      kind: 'reply',
      text: ctx.templates.myPropertiesView({
        properties: result.value.properties.map((p) => ({
          propertyCode: p.propertyCode,
          label: p.label,
          flatCount: p.flatCount,
          occupiedCount: p.occupiedCount,
          pendingEarningsGrd: p.pendingEarningsGrd,
        })),
      }),
    };
  }
}
