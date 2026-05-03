import { describe, expect, it } from 'vitest';
import { Ok } from '../../src/client';
import { TenantOnboardingFlow } from '../../src/flows';
import { apiError, errResult, makeContext } from './harness';

const flow = new TenantOnboardingFlow();

describe('TenantOnboardingFlow.handles', () => {
  it.each([
    'TENANT_REG_NAME',
    'TENANT_REG_PHONE',
    'TENANT_REG_OTP',
    'TENANT_REG_PROP_CODE',
  ] as const)('handles %s', (step) => expect(flow.handles(step)).toBe(true));

  it.each(['LANDLORD_REG_NAME', 'BUY_AMOUNT', 'TENANT_AUTHENTICATED'] as const)(
    'does not handle %s',
    (step) => expect(flow.handles(step)).toBe(false),
  );
});

describe('TENANT_REG_NAME', () => {
  it('advances to TENANT_REG_PHONE on valid name', async () => {
    const { ctx } = makeContext({ step: 'TENANT_REG_NAME' });
    const result = await flow.handle(ctx, 'Musa Ibrahim');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('TENANT_REG_PHONE');
  });
});

describe('TENANT_REG_PHONE', () => {
  it('calls registerTenant and advances to OTP', async () => {
    const { ctx, client } = makeContext({
      step: 'TENANT_REG_PHONE',
      data: { fullName: 'Musa Ibrahim' },
    });
    const result = await flow.handle(ctx, '+2348031111111');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('TENANT_REG_OTP');
    expect(client.calls.registerTenant).toEqual([
      { fullName: 'Musa Ibrahim', phone: '+2348031111111' },
    ]);
  });
});

describe('TENANT_REG_OTP', () => {
  const baseData = {
    fullName: 'Musa Ibrahim',
    phone: '+2348031111111',
    otpRef: 'fake-otp-ref',
    otpAttempts: 0,
  };

  it('verifies OTP and advances to property code prompt', async () => {
    const { ctx, client } = makeContext({ step: 'TENANT_REG_OTP', data: baseData });
    client.verifyOtpResult = Ok({
      jwt: 'jwt.tenant.token',
      userId: 'usr_2',
      role: 'tenant',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const result = await flow.handle(ctx, '123456');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('TENANT_REG_PROP_CODE');
    expect(result.patch.role).toBe('tenant');
    expect(result.patch.jwt).toBe('jwt.tenant.token');
    expect(result.reply).toContain('Property Code');
  });

  it('resets if backend returns role=landlord (server confusion)', async () => {
    const { ctx, client } = makeContext({ step: 'TENANT_REG_OTP', data: baseData });
    client.verifyOtpResult = Ok({
      jwt: 'jwt',
      userId: 'usr_2',
      role: 'landlord',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const result = await flow.handle(ctx, '123456');
    expect(result.kind).toBe('reset');
  });
});

describe('TENANT_REG_PROP_CODE', () => {
  it('completes flow on valid property code', async () => {
    const { ctx, client } = makeContext({
      step: 'TENANT_REG_PROP_CODE',
      jwt: 'jwt.tenant.token',
      role: 'tenant',
      data: { fullName: 'Musa Ibrahim' },
    });
    const result = await flow.handle(ctx, 'GRD-LAG-0042');
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.patch.step).toBe('TENANT_AUTHENTICATED');
    expect(result.patch.clearData).toBe(true);
    expect(result.reply).toContain('Surulere Block A');
    expect(result.reply).toContain('Adeola Bayo');
    expect(client.calls.linkProperty).toEqual([{ propertyCode: 'GRD-LAG-0042' }]);
  });

  it('normalizes lowercase input to upper-case', async () => {
    const { ctx, client } = makeContext({
      step: 'TENANT_REG_PROP_CODE',
      jwt: 'jwt',
      role: 'tenant',
    });
    await flow.handle(ctx, 'grd-lag-0042');
    expect(client.calls.linkProperty[0]?.propertyCode).toBe('GRD-LAG-0042');
  });

  it('rejects malformed property codes without calling backend', async () => {
    const { ctx, client } = makeContext({
      step: 'TENANT_REG_PROP_CODE',
      jwt: 'jwt',
      role: 'tenant',
    });
    const result = await flow.handle(ctx, 'GRD-XX-0042');
    expect(result.kind).toBe('stay');
    if (result.kind !== 'stay') return;
    expect(result.reply).toContain('property code');
    expect(client.calls.linkProperty).toHaveLength(0);
  });

  it('handles INVALID_PROPERTY_CODE from backend', async () => {
    const { ctx, client } = makeContext({
      step: 'TENANT_REG_PROP_CODE',
      jwt: 'jwt',
      role: 'tenant',
    });
    client.linkPropertyResult = errResult(apiError('INVALID_PROPERTY_CODE', 404));
    const result = await flow.handle(ctx, 'GRD-LAG-9999');
    expect(result.kind).toBe('stay');
    if (result.kind !== 'stay') return;
    expect(result.reply).toContain('not recognized');
  });

  it('handles PROPERTY_FULL → reset', async () => {
    const { ctx, client } = makeContext({
      step: 'TENANT_REG_PROP_CODE',
      jwt: 'jwt',
      role: 'tenant',
    });
    client.linkPropertyResult = errResult(apiError('PROPERTY_FULL', 409));
    const result = await flow.handle(ctx, 'GRD-LAG-0042');
    expect(result.kind).toBe('reset');
  });

  it('resets if jwt is missing', async () => {
    const { ctx } = makeContext({ step: 'TENANT_REG_PROP_CODE', role: 'tenant' });
    const result = await flow.handle(ctx, 'GRD-LAG-0042');
    expect(result.kind).toBe('reset');
  });
});
