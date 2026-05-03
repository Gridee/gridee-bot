import type { SessionStep } from '../session/types';
import type { FlowContext, FlowResult, IFlow } from './IFlow';
import { parseRoleSelection } from './helpers';

/**
 * Role selection — the entry point for any new conversation, and the
 * destination of any "reset" from a deeper flow.
 *
 * Accepts: "1", "2", "LANDLORD", "TENANT" (case-insensitive).
 */
export class RoleSelectionFlow implements IFlow {
  readonly id = 'ROLE_SELECTION';

  handles(step: SessionStep): boolean {
    return step === 'WELCOME_ROLE_SELECT';
  }

  async handle(ctx: FlowContext, message: string): Promise<FlowResult> {
    if (ctx.session.step !== 'WELCOME_ROLE_SELECT') {
      return { kind: 'passthrough' };
    }

    const role = parseRoleSelection(message);
    if (!role) {
      return { kind: 'stay', reply: ctx.templates.rolePrompt() };
    }

    if (role === 'landlord') {
      return {
        kind: 'advance',
        reply: ctx.templates.landlordRegName(),
        patch: { step: 'LANDLORD_REG_NAME', clearData: true },
      };
    }

    return {
      kind: 'advance',
      reply: ctx.templates.tenantRegName(),
      patch: { step: 'TENANT_REG_NAME', clearData: true },
    };
  }
}
