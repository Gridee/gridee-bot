import { describe, expect, it } from 'vitest';
import {
  BuyFlow,
  FlowRegistry,
  LandlordOnboardingFlow,
  RoleSelectionFlow,
  TenantOnboardingFlow,
  type IFlow,
} from '../../src/flows';
import type { SessionStep } from '../../src/session/types';

describe('FlowRegistry', () => {
  it('default registry contains all 4 flows with no overlaps', () => {
    const registry = FlowRegistry.default();
    expect(registry.all()).toHaveLength(4);
  });

  it('routes WELCOME_ROLE_SELECT to RoleSelectionFlow', () => {
    const registry = FlowRegistry.default();
    expect(registry.findForStep('WELCOME_ROLE_SELECT')?.id).toBe('ROLE_SELECTION');
  });

  it('routes LANDLORD_REG_NAME to LandlordOnboardingFlow', () => {
    const registry = FlowRegistry.default();
    expect(registry.findForStep('LANDLORD_REG_NAME')?.id).toBe('LANDLORD_ONBOARDING');
  });

  it('routes TENANT_REG_OTP to TenantOnboardingFlow', () => {
    const registry = FlowRegistry.default();
    expect(registry.findForStep('TENANT_REG_OTP')?.id).toBe('TENANT_ONBOARDING');
  });

  it('routes BUY_AMOUNT to BuyFlow', () => {
    const registry = FlowRegistry.default();
    expect(registry.findForStep('BUY_AMOUNT')?.id).toBe('BUY');
  });

  it('returns null for steps with no flow (terminal/idle states)', () => {
    const registry = FlowRegistry.default();
    expect(registry.findForStep('TENANT_AUTHENTICATED')).toBeNull();
    expect(registry.findForStep('WITHDRAW_BANK_INPUT')).toBeNull();
  });

  it('throws at construction if two flows claim the same step', () => {
    const greedy: IFlow = {
      id: 'GREEDY',
      handles(step: SessionStep): boolean {
        return step === 'BUY_AMOUNT'; // overlaps with BuyFlow
      },
      async handle() {
        throw new Error('not used');
      },
    };
    expect(() => new FlowRegistry([new BuyFlow(), greedy])).toThrow(/claimed by both/);
  });

  it('does not throw when flows have disjoint step sets', () => {
    expect(() =>
      new FlowRegistry([
        new RoleSelectionFlow(),
        new LandlordOnboardingFlow(),
        new TenantOnboardingFlow(),
        new BuyFlow(),
      ]),
    ).not.toThrow();
  });
});
