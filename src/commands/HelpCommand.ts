import type { ICommand, CommandContext, CommandResult } from './ICommand';
import type { SessionState } from '../session/types';

/**
 * HELP — works for any user, any step. Shows the role-appropriate menu.
 */
export class HelpCommand implements ICommand {
  readonly id = 'HELP';

  matches(message: string, _session: SessionState): boolean {
    return message.trim().toUpperCase() === 'HELP';
  }

  async handle(ctx: CommandContext, _message: string): Promise<CommandResult> {
    if (ctx.session.role === 'tenant') {
      return { kind: 'reply', text: ctx.templates.helpTenant() };
    }
    if (ctx.session.role === 'landlord') {
      return { kind: 'reply', text: ctx.templates.helpLandlord() };
    }
    return { kind: 'reply', text: ctx.templates.helpUnauthenticated() };
  }
}
