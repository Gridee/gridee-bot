import { describe, expect, it } from 'vitest';
import { RoleSelectionFlow } from '../../src/flows';
import { makeContext } from './harness';

describe('RoleSelectionFlow', () => {
  const flow = new RoleSelectionFlow();

  it('handles WELCOME_ROLE_SELECT and nothing else', () => {
    expect(flow.handles('WELCOME_ROLE_SELECT')).toBe(true);
    expect(flow.handles('LANDLORD_REG_NAME')).toBe(false);
    expect(flow.handles('BUY_AMOUNT')).toBe(false);
  });

  it.each([
    ['1', 'LANDLORD_REG_NAME'],
    ['LANDLORD', 'LANDLORD_REG_NAME'],
    ['landlord', 'LANDLORD_REG_NAME'],
    [' 1 ', 'LANDLORD_REG_NAME'],
    ['2', 'TENANT_REG_NAME'],
    ['TENANT', 'TENANT_REG_NAME'],
    ['tenant', 'TENANT_REG_NAME'],
  ])('parses "%s" → %s', async (input, expectedStep) => {
    const { ctx } = makeContext({ step: 'WELCOME_ROLE_SELECT' });
    const result = await flow.handle(ctx, input);
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe(expectedStep);
    expect(result.patch.clearData).toBe(true);
  });

  it.each([['hi'], ['3'], ['hello there'], [''], ['12']])('rejects "%s" with re-prompt', async (input) => {
    const { ctx } = makeContext({ step: 'WELCOME_ROLE_SELECT' });
    const result = await flow.handle(ctx, input);
    expect(result.kind).toBe('stay');
    if (result.kind !== 'stay') return;
    expect(result.reply).toContain('Landlord');
    expect(result.reply).toContain('Tenant');
  });

  it('returns passthrough for steps it does not handle', async () => {
    const { ctx } = makeContext({ step: 'LANDLORD_REG_NAME' });
    const result = await flow.handle(ctx, 'whatever');
    expect(result.kind).toBe('passthrough');
  });
});
