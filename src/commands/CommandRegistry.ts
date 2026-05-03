import type { ICommand, CommandContext, CommandResult } from './ICommand';
import type { SessionState } from '../session/types';
import { BalanceCommand } from './BalanceCommand';
import { EarningsCommand } from './EarningsCommand';
import { HelpCommand } from './HelpCommand';
import { HistoryCommand } from './HistoryCommand';
import { MenuCommand } from './MenuCommand';
import { MyPropertiesCommand } from './MyPropertiesCommand';

/**
 * Registry of post-flow idle commands. The dispatcher calls `find()` when
 * no flow handles the current step (or when a flow returns passthrough).
 *
 * First-match semantics: commands are evaluated in registration order, and
 * the first whose `matches()` returns true wins. If none match, the
 * dispatcher sends a generic "didn't recognize" reply.
 */
export class CommandRegistry {
  private readonly commands: ReadonlyArray<ICommand>;

  constructor(commands: ReadonlyArray<ICommand>) {
    this.commands = commands;
  }

  static default(): CommandRegistry {
    return new CommandRegistry(DEFAULT_COMMANDS);
  }

  /**
   * Find the first command whose matches() returns true.
   * Returns null if no command matches.
   */
  find(message: string, session: SessionState): ICommand | null {
    return this.commands.find((c) => c.matches(message, session)) ?? null;
  }

  /**
   * Convenience: find + handle in one call. Returns null if no match.
   */
  async handle(
    ctx: CommandContext,
    message: string,
  ): Promise<CommandResult | null> {
    const cmd = this.find(message, ctx.session);
    if (!cmd) return null;
    return cmd.handle(ctx, message);
  }

  /** All registered commands. Mainly for tests. */
  all(): ReadonlyArray<ICommand> {
    return this.commands;
  }
}

const DEFAULT_COMMANDS: ReadonlyArray<ICommand> = [
  // Global commands first — work for any role and any step
  new MenuCommand(),
  // HELP works for any role too
  new HelpCommand(),
  // Tenant commands
  new BalanceCommand(),
  new HistoryCommand(),
  // Landlord commands
  new MyPropertiesCommand(),
  new EarningsCommand(),
];
