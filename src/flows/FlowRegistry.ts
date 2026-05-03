import type { SessionStep } from '../session/types';
import { BuyFlow } from './BuyFlow';
import type { IFlow } from './IFlow';
import { LandlordOnboardingFlow } from './LandlordOnboardingFlow';
import { RoleSelectionFlow } from './RoleSelectionFlow';
import { TenantOnboardingFlow } from './TenantOnboardingFlow';

/**
 * Registry of all flows. The dispatcher uses `findForStep()` to route an
 * incoming message to the right flow.
 *
 * Adding a new flow:
 *   1. Implement IFlow
 *   2. Add it to DEFAULT_FLOWS below (or pass into the constructor)
 *   3. Make sure its handles() doesn't overlap with any existing flow's
 */
export class FlowRegistry {
  private readonly flows: ReadonlyArray<IFlow>;

  constructor(flows: ReadonlyArray<IFlow>) {
    // Detect overlap at construction so we fail loudly at boot, not at runtime.
    detectOverlap(flows);
    this.flows = flows;
  }

  static default(): FlowRegistry {
    return new FlowRegistry(DEFAULT_FLOWS);
  }

  /**
   * Returns the flow that handles the given step, or null if none does.
   * The dispatcher treats null as "no flow active" and routes to commands
   * or sends a generic prompt.
   */
  findForStep(step: SessionStep): IFlow | null {
    return this.flows.find((f) => f.handles(step)) ?? null;
  }

  /** All registered flows, in registration order. Mainly for tests / logs. */
  all(): ReadonlyArray<IFlow> {
    return this.flows;
  }
}

const DEFAULT_FLOWS: ReadonlyArray<IFlow> = [
  new RoleSelectionFlow(),
  new LandlordOnboardingFlow(),
  new TenantOnboardingFlow(),
  new BuyFlow(),
];

/** All session steps, used to verify no two flows overlap. */
const ALL_STEPS: ReadonlyArray<SessionStep> = [
  'WELCOME_ROLE_SELECT',
  'LANDLORD_REG_NAME',
  'LANDLORD_REG_PHONE',
  'LANDLORD_REG_OTP',
  'LANDLORD_AUTHENTICATED',
  'TENANT_REG_NAME',
  'TENANT_REG_PHONE',
  'TENANT_REG_OTP',
  'TENANT_REG_PROP_CODE',
  'TENANT_AUTHENTICATED',
  'ADD_PROPERTY_ADDRESS',
  'ADD_PROPERTY_FLAT_COUNT',
  'ADD_PROPERTY_LABEL',
  'BUY_AMOUNT',
  'BUY_CONFIRM',
  'AWAITING_PAYMENT',
  'WITHDRAW_BANK_INPUT',
  'WITHDRAW_CONFIRM',
  'REMOVE_TENANT_PHONE',
  'REMOVE_TENANT_CONFIRM',
];

function detectOverlap(flows: ReadonlyArray<IFlow>): void {
  const owner = new Map<SessionStep, string>();
  for (const flow of flows) {
    for (const step of ALL_STEPS) {
      if (flow.handles(step)) {
        const existing = owner.get(step);
        if (existing !== undefined) {
          throw new Error(
            `FlowRegistry: step "${step}" is claimed by both "${existing}" and "${flow.id}"`,
          );
        }
        owner.set(step, flow.id);
      }
    }
  }
}
