import { describe, expect, it } from 'vitest';
import { Ok } from '../../src/client';
import { LandlordOnboardingFlow } from '../../src/flows';
import { apiError, authError, errResult, makeContext, networkError } from './harness';

const flow = new LandlordOnboardingFlow();

// ─── handles() exhaustiveness ──────────────────────────────────────────────

describe('LandlordOnboardingFlow.handles', () => {
  const ours = [
    'LANDLORD_REG_NAME',
    'LANDLORD_REG_PHONE',
    'LANDLORD_REG_OTP',
    'ADD_PROPERTY_ADDRESS',
    'ADD_PROPERTY_FLAT_COUNT',
    'ADD_PROPERTY_LABEL',
  ] as const;
  const notOurs = [
    'WELCOME_ROLE_SELECT',
    'TENANT_REG_NAME',
    'BUY_AMOUNT',
    'LANDLORD_AUTHENTICATED', // terminal — commands handle it now, not the flow
  ] as const;

  it.each(ours)('handles %s', (step) => expect(flow.handles(step)).toBe(true));
  it.each(notOurs)('does not handle %s', (step) => expect(flow.handles(step)).toBe(false));
});

// ─── LANDLORD_REG_NAME ─────────────────────────────────────────────────────

describe('LANDLORD_REG_NAME', () => {
  it('accepts a valid name and advances to LANDLORD_REG_PHONE', async () => {
    const { ctx } = makeContext({ step: 'LANDLORD_REG_NAME' });
    const result = await flow.handle(ctx, 'Adeola Bayo');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('LANDLORD_REG_PHONE');
    expect(result.patch.data?.['fullName']).toBe('Adeola Bayo');
  });

  it.each([['A'], ['Ade123'], [''], ['   '], ['$$$']])('rejects "%s"', async (input) => {
    const { ctx } = makeContext({ step: 'LANDLORD_REG_NAME' });
    const result = await flow.handle(ctx, input);
    expect(result.kind).toBe('stay');
  });

  it('accepts names with apostrophes and hyphens', async () => {
    const { ctx } = makeContext({ step: 'LANDLORD_REG_NAME' });
    const result = await flow.handle(ctx, "O'Brien-Adekunle");
    expect(result.kind).toBe('advance');
  });
});

// ─── LANDLORD_REG_PHONE ────────────────────────────────────────────────────

describe('LANDLORD_REG_PHONE', () => {
  it('calls registerLandlord and advances to OTP step', async () => {
    const { ctx, client } = makeContext({
      step: 'LANDLORD_REG_PHONE',
      data: { fullName: 'Adeola Bayo' },
    });
    const result = await flow.handle(ctx, '+2348031234567');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('LANDLORD_REG_OTP');
    expect(result.patch.data?.['otpRef']).toBe('fake-otp-ref');
    expect(result.patch.data?.['otpAttempts']).toBe(0);
    expect(client.calls.registerLandlord).toEqual([
      { fullName: 'Adeola Bayo', phone: '+2348031234567' },
    ]);
  });

  it('rejects malformed phone without calling backend', async () => {
    const { ctx, client } = makeContext({
      step: 'LANDLORD_REG_PHONE',
      data: { fullName: 'Adeola Bayo' },
    });
    const result = await flow.handle(ctx, '08031234567'); // missing +
    expect(result.kind).toBe('stay');
    expect(client.calls.registerLandlord).toHaveLength(0);
  });

  it('resets when fullName is missing from session.data (corrupt state)', async () => {
    const { ctx, client } = makeContext({ step: 'LANDLORD_REG_PHONE', data: {} });
    const result = await flow.handle(ctx, '+2348031234567');
    expect(result.kind).toBe('reset');
    expect(client.calls.registerLandlord).toHaveLength(0);
  });

  it('handles ALREADY_REGISTERED → reset', async () => {
    const { ctx, client } = makeContext({
      step: 'LANDLORD_REG_PHONE',
      data: { fullName: 'Adeola Bayo' },
    });
    client.registerLandlordResult = errResult(apiError('ALREADY_REGISTERED', 409));
    const result = await flow.handle(ctx, '+2348031234567');
    expect(result.kind).toBe('reset');
    if (result.kind !== 'reset') return;
    expect(result.reply).toContain('already registered');
  });

  it('handles network error → stay (user can retry)', async () => {
    const { ctx, client } = makeContext({
      step: 'LANDLORD_REG_PHONE',
      data: { fullName: 'Adeola Bayo' },
    });
    client.registerLandlordResult = errResult(networkError());
    const result = await flow.handle(ctx, '+2348031234567');
    expect(result.kind).toBe('stay');
  });
});

// ─── LANDLORD_REG_OTP ──────────────────────────────────────────────────────

describe('LANDLORD_REG_OTP', () => {
  const baseData = {
    fullName: 'Adeola Bayo',
    phone: '+2348031234567',
    otpRef: 'fake-otp-ref',
    otpAttempts: 0,
  };

  it('verifies a valid OTP and advances to ADD_PROPERTY_ADDRESS with JWT', async () => {
    const { ctx, client } = makeContext({ step: 'LANDLORD_REG_OTP', data: baseData });
    const result = await flow.handle(ctx, '123456');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('ADD_PROPERTY_ADDRESS');
    expect(result.patch.role).toBe('landlord');
    expect(result.patch.jwt).toBe('jwt.fake.token');
    expect(result.patch.userId).toBe('usr_1');
    expect(result.patch.clearData).toBe(true);
    expect(result.patch.data?.['fullName']).toBe('Adeola Bayo');
    // Reply should contain BOTH the welcome AND the address prompt
    expect(result.reply).toContain('Adeola Bayo');
    expect(result.reply).toContain('property address');
    expect(client.calls.verifyOtp).toEqual([{ otpRef: 'fake-otp-ref', otp: '123456' }]);
  });

  it('handles RESEND keyword without advancing step', async () => {
    const { ctx, client } = makeContext({
      step: 'LANDLORD_REG_OTP',
      data: { ...baseData, otpAttempts: 2 },
    });
    const result = await flow.handle(ctx, 'RESEND');
    expect(result.kind).toBe('stay');
    if (result.kind !== 'stay') return;
    expect(result.patch?.data?.['otpAttempts']).toBe(0);
    expect(client.calls.resendOtp).toEqual([{ otpRef: 'fake-otp-ref' }]);
    expect(client.calls.verifyOtp).toHaveLength(0);
  });

  it('handles lowercase resend', async () => {
    const { ctx } = makeContext({ step: 'LANDLORD_REG_OTP', data: baseData });
    const result = await flow.handle(ctx, 'resend');
    expect(result.kind).toBe('stay');
  });

  it.each([['12345'], ['abcdef'], ['1234567'], ['']])('rejects malformed OTP "%s"', async (otp) => {
    const { ctx, client } = makeContext({ step: 'LANDLORD_REG_OTP', data: baseData });
    const result = await flow.handle(ctx, otp);
    expect(result.kind).toBe('stay');
    expect(client.calls.verifyOtp).toHaveLength(0);
  });

  it('bumps otpAttempts on INVALID_OTP', async () => {
    const { ctx, client } = makeContext({
      step: 'LANDLORD_REG_OTP',
      data: { ...baseData, otpAttempts: 0 },
    });
    client.verifyOtpResult = errResult(apiError('INVALID_OTP', 400, { attemptsLeft: 2 }));
    const result = await flow.handle(ctx, '000000');
    expect(result.kind).toBe('stay');
    if (result.kind !== 'stay') return;
    expect(result.patch?.data?.['otpAttempts']).toBe(1);
    expect(result.reply).toContain('2 attempts left');
  });

  it('resets after MAX_OTP_ATTEMPTS', async () => {
    const { ctx, client } = makeContext({
      step: 'LANDLORD_REG_OTP',
      data: { ...baseData, otpAttempts: 3 },
    });
    const result = await flow.handle(ctx, '000000');
    expect(result.kind).toBe('reset');
    expect(client.calls.verifyOtp).toHaveLength(0);
  });

  it('handles OTP_EXPIRED', async () => {
    const { ctx, client } = makeContext({ step: 'LANDLORD_REG_OTP', data: baseData });
    client.verifyOtpResult = errResult(apiError('OTP_EXPIRED', 400));
    const result = await flow.handle(ctx, '123456');
    expect(result.kind).toBe('stay');
    if (result.kind !== 'stay') return;
    expect(result.reply).toContain('expired');
  });

  it('handles auth error → reset', async () => {
    const { ctx, client } = makeContext({ step: 'LANDLORD_REG_OTP', data: baseData });
    client.verifyOtpResult = errResult(authError());
    const result = await flow.handle(ctx, '123456');
    expect(result.kind).toBe('reset');
  });

  it('resets if backend returns role=tenant for landlord flow (corrupt server)', async () => {
    const { ctx, client, capturedLogs } = makeContext({ step: 'LANDLORD_REG_OTP', data: baseData });
    client.verifyOtpResult = Ok({
      jwt: 'jwt',
      userId: 'usr_1',
      role: 'tenant',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const result = await flow.handle(ctx, '123456');
    expect(result.kind).toBe('reset');
    expect(capturedLogs.some((l) => l.level === 'error')).toBe(true);
  });

  it('resets if otpRef is missing from session.data', async () => {
    const { ctx } = makeContext({ step: 'LANDLORD_REG_OTP', data: { fullName: 'X' } });
    const result = await flow.handle(ctx, '123456');
    expect(result.kind).toBe('reset');
  });
});

// ─── LANDLORD_AUTHENTICATED — terminal idle state, flow passes through ─────

describe('LANDLORD_AUTHENTICATED', () => {
  it('returns passthrough — commands handle this step, not the flow', async () => {
    const { ctx } = makeContext({
      step: 'LANDLORD_AUTHENTICATED',
      jwt: 'jwt',
      userId: 'usr_1',
      role: 'landlord',
    });
    const result = await flow.handle(ctx, 'whatever');
    expect(result.kind).toBe('passthrough');
  });
});

// ─── ADD_PROPERTY_ADDRESS ──────────────────────────────────────────────────

describe('ADD_PROPERTY_ADDRESS', () => {
  it('accepts a valid address', async () => {
    const { ctx } = makeContext({
      step: 'ADD_PROPERTY_ADDRESS',
      jwt: 'jwt',
      role: 'landlord',
    });
    const result = await flow.handle(ctx, '12 Adeniran Ogunsanya St, Surulere, Lagos');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('ADD_PROPERTY_FLAT_COUNT');
    expect(result.patch.data?.['address']).toBe('12 Adeniran Ogunsanya St, Surulere, Lagos');
  });

  it('rejects too-short address', async () => {
    const { ctx } = makeContext({ step: 'ADD_PROPERTY_ADDRESS', jwt: 'jwt' });
    const result = await flow.handle(ctx, 'a b');
    expect(result.kind).toBe('stay');
  });
});

// ─── ADD_PROPERTY_FLAT_COUNT ───────────────────────────────────────────────

describe('ADD_PROPERTY_FLAT_COUNT', () => {
  it.each([['6', 6], ['1', 1], ['1000', 1000]])('accepts "%s" as %i', async (input, n) => {
    const { ctx } = makeContext({
      step: 'ADD_PROPERTY_FLAT_COUNT',
      jwt: 'jwt',
      data: { address: '12 Adeniran St, Surulere, Lagos' },
    });
    const result = await flow.handle(ctx, input);
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.data?.['flatCount']).toBe(n);
  });

  it.each([['0'], ['1001'], ['3.5'], ['3 flats'], ['three'], ['-2']])(
    'rejects "%s"',
    async (input) => {
      const { ctx } = makeContext({
        step: 'ADD_PROPERTY_FLAT_COUNT',
        jwt: 'jwt',
        data: { address: '12 Adeniran St' },
      });
      const result = await flow.handle(ctx, input);
      expect(result.kind).toBe('stay');
    },
  );
});

// ─── ADD_PROPERTY_LABEL ────────────────────────────────────────────────────

describe('ADD_PROPERTY_LABEL', () => {
  const baseData = { address: '12 Adeniran St, Surulere, Lagos', flatCount: 6 };

  it('completes the flow on valid label', async () => {
    const { ctx, client } = makeContext({
      step: 'ADD_PROPERTY_LABEL',
      jwt: 'jwt',
      role: 'landlord',
      data: baseData,
    });
    const result = await flow.handle(ctx, 'Surulere Block A');
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.patch.step).toBe('LANDLORD_AUTHENTICATED');
    expect(result.patch.clearData).toBe(true);
    expect(result.reply).toContain('GRD-LAG-0042');
    expect(result.reply).toContain('Surulere Block A');
    expect(client.calls.addProperty).toEqual([
      { address: baseData.address, flatCount: 6, label: 'Surulere Block A' },
    ]);
  });

  it('resets if jwt is missing', async () => {
    const { ctx } = makeContext({ step: 'ADD_PROPERTY_LABEL', data: baseData });
    const result = await flow.handle(ctx, 'Surulere Block A');
    expect(result.kind).toBe('reset');
  });

  it('resets if address/flatCount are missing (corrupt state)', async () => {
    const { ctx, client } = makeContext({
      step: 'ADD_PROPERTY_LABEL',
      jwt: 'jwt',
      data: { address: '12 Adeniran St' /* flatCount missing */ },
    });
    const result = await flow.handle(ctx, 'Surulere Block A');
    expect(result.kind).toBe('reset');
    expect(client.calls.addProperty).toHaveLength(0);
  });
});

// ─── End-to-end happy path ─────────────────────────────────────────────────

describe('LandlordOnboardingFlow — end-to-end happy path', () => {
  it('walks all steps with correct backend calls', async () => {
    const { client } = (await runHappyPath());
    expect(client.calls.registerLandlord).toEqual([
      { fullName: 'Adeola Bayo', phone: '+2348031234567' },
    ]);
    expect(client.calls.verifyOtp).toEqual([{ otpRef: 'fake-otp-ref', otp: '123456' }]);
    expect(client.calls.addProperty).toEqual([
      { address: '12 Adeniran St, Surulere, Lagos', flatCount: 6, label: 'Surulere Block A' },
    ]);
  });
});

/**
 * Drives the flow through every step using the dispatcher-style pattern:
 * each step's `patch` is applied to a running session to compute the next.
 * This is exactly how the real dispatcher will compose flows.
 */
async function runHappyPath(): Promise<{ client: import('./harness').FakeBackendClient }> {
  const { ctx, client } = makeContext({ step: 'LANDLORD_REG_NAME' });
  let session = ctx.session;

  const steps: ReadonlyArray<readonly [string, string]> = [
    ['LANDLORD_REG_NAME', 'Adeola Bayo'],
    ['LANDLORD_REG_PHONE', '+2348031234567'],
    ['LANDLORD_REG_OTP', '123456'],
    ['ADD_PROPERTY_ADDRESS', '12 Adeniran St, Surulere, Lagos'],
    ['ADD_PROPERTY_FLAT_COUNT', '6'],
    ['ADD_PROPERTY_LABEL', 'Surulere Block A'],
  ];

  for (const [expectedStep, message] of steps) {
    expect(session.step).toBe(expectedStep);
    const result = await flow.handle({ ...ctx, session }, message);
    expect(['advance', 'complete']).toContain(result.kind);
    if (result.kind !== 'advance' && result.kind !== 'complete') break;
    // Apply the patch to the session
    session = applyPatch(session, result.patch);
  }
  expect(session.step).toBe('LANDLORD_AUTHENTICATED');
  return { client };
}

import type { SessionPatch } from '../../src/flows';
import type { SessionState } from '../../src/session/types';

function applyPatch(session: SessionState, patch: SessionPatch): SessionState {
  const next: SessionState = {
    ...session,
    updatedAt: Date.now(),
  };
  if (patch.step !== undefined) next.step = patch.step;
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.jwt !== undefined) next.jwt = patch.jwt;
  if (patch.userId !== undefined) next.userId = patch.userId;
  if (patch.jwtClear) delete next.jwt;
  if (patch.clearData) {
    next.data = { ...(patch.data ?? {}) };
  } else if (patch.data !== undefined) {
    next.data = { ...next.data, ...patch.data };
  }
  return next;
}
