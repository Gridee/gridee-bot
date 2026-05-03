import { describe, expect, it } from 'vitest';
import { Ok } from '../../src/client';
import {
  BalanceCommand,
  CommandRegistry,
  EarningsCommand,
  HelpCommand,
  HistoryCommand,
  MyPropertiesCommand,
} from '../../src/commands';
import { Phone } from '../../src/lib/phone';
import { newSessionState, type SessionState } from '../../src/session/types';
import { DefaultTemplates } from '../../src/templates';
import { FakeBackendClient, apiError, errResult } from '../flows/harness';

const PHONE = Phone.of('+2348031234567');

function makeCtx(opts: {
  role: 'tenant' | 'landlord' | null;
  step: SessionState['step'];
  jwt?: string;
  client?: FakeBackendClient;
}): {
  ctx: import('../../src/commands').CommandContext;
  client: FakeBackendClient;
} {
  const client = opts.client ?? new FakeBackendClient();
  const session: SessionState = {
    ...newSessionState({ step: opts.step }),
    role: opts.role,
    ...(opts.jwt ? { jwt: opts.jwt } : {}),
  };
  const log = {
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  } as unknown as import('../../src/commands').CommandContext['log'];
  return {
    ctx: {
      phone: PHONE,
      session,
      client: client as unknown as import('../../src/commands').CommandContext['client'],
      templates: new DefaultTemplates(),
      log,
    },
    client,
  };
}

// ─── HelpCommand ──────────────────────────────────────────────────────────

describe('HelpCommand', () => {
  const cmd = new HelpCommand();

  it.each(['HELP', 'help', ' Help '])('matches %s', (input) => {
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' });
    expect(cmd.matches(input, ctx.session)).toBe(true);
  });

  it.each(['BALANCE', 'helo', 'HELP me'])('does not match %s', (input) => {
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' });
    expect(cmd.matches(input, ctx.session)).toBe(false);
  });

  it('returns tenant help when role=tenant', async () => {
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' });
    const r = await cmd.handle(ctx, 'HELP');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('BUY');
    expect(r.text).toContain('BALANCE');
    expect(r.text).not.toContain('MY_PROPERTIES');
  });

  it('returns landlord help when role=landlord', async () => {
    const { ctx } = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED' });
    const r = await cmd.handle(ctx, 'HELP');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('MY_PROPERTIES');
    expect(r.text).toContain('EARNINGS');
    expect(r.text).not.toContain('BALANCE');
  });

  it('returns unauthenticated help when role=null', async () => {
    const { ctx } = makeCtx({ role: null, step: 'WELCOME_ROLE_SELECT' });
    const r = await cmd.handle(ctx, 'HELP');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toMatch(/register/i);
  });
});

// ─── BalanceCommand ──────────────────────────────────────────────────────

describe('BalanceCommand', () => {
  const cmd = new BalanceCommand();

  it('matches BALANCE for tenant only', () => {
    const tenantSession = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    const landlordSession = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED' }).ctx.session;
    expect(cmd.matches('BALANCE', tenantSession)).toBe(true);
    expect(cmd.matches('BALANCE', landlordSession)).toBe(false);
  });

  it('returns balance view from backend', async () => {
    const client = new FakeBackendClient();
    // FakeBackendClient doesn't have getBalance default — we'll add one inline
    (client as unknown as { getBalanceResult: unknown }).getBalanceResult = Ok({
      balanceGrd: 5.5,
      estimatedDaysRemaining: 11,
      status: 'CONNECTED',
      lastUpdatedAt: new Date().toISOString(),
    });
    // Override the method since FakeBackendClient may not stub it
    (client as unknown as { getBalance: () => unknown }).getBalance = async () =>
      Ok({
        balanceGrd: 5.5,
        estimatedDaysRemaining: 11,
        status: 'CONNECTED',
        lastUpdatedAt: new Date().toISOString(),
      });

    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED', jwt: 'jwt', client });
    const r = await cmd.handle(ctx, 'BALANCE');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('5.50 GRD');
    expect(r.text).toContain('CONNECTED');
  });

  it('handles missing JWT', async () => {
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' });
    const r = await cmd.handle(ctx, 'BALANCE');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toMatch(/expired/i);
  });

  it('handles backend error', async () => {
    const client = new FakeBackendClient();
    (client as unknown as { getBalance: () => unknown }).getBalance = async () =>
      errResult(apiError('INTERNAL', 500));
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED', jwt: 'jwt', client });
    const r = await cmd.handle(ctx, 'BALANCE');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toMatch(/temporarily unavailable/i);
  });
});

// ─── HistoryCommand ──────────────────────────────────────────────────────

describe('HistoryCommand', () => {
  const cmd = new HistoryCommand();

  it('matches HISTORY for tenant only', () => {
    const tenantSession = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    const landlordSession = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED' }).ctx.session;
    expect(cmd.matches('HISTORY', tenantSession)).toBe(true);
    expect(cmd.matches('HISTORY', landlordSession)).toBe(false);
  });

  it('shows empty state when no transactions', async () => {
    const client = new FakeBackendClient();
    (client as unknown as { getHistory: () => unknown }).getHistory = async () =>
      Ok({ transactions: [] });
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED', jwt: 'jwt', client });
    const r = await cmd.handle(ctx, 'HISTORY');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toMatch(/no transactions/i);
  });

  it('formats transactions', async () => {
    const client = new FakeBackendClient();
    (client as unknown as { getHistory: () => unknown }).getHistory = async () =>
      Ok({
        transactions: [
          {
            txId: 'tx_1',
            kind: 'TOPUP',
            amountGrd: 4.0,
            amountNgn: 5000,
            balanceAfterGrd: 4.0,
            at: '2026-05-01T10:00:00.000Z',
          },
          {
            txId: 'tx_2',
            kind: 'CONSUMPTION',
            amountGrd: -0.5,
            amountNgn: null,
            balanceAfterGrd: 3.5,
            at: '2026-05-01T11:00:00.000Z',
          },
        ],
      });
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED', jwt: 'jwt', client });
    const r = await cmd.handle(ctx, 'HISTORY');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('+4.00 GRD');
    expect(r.text).toContain('₦5,000');
    expect(r.text).toContain('-0.50 GRD');
    expect(r.text).toContain('topup');
    expect(r.text).toContain('consumption');
  });
});

// ─── MyPropertiesCommand ─────────────────────────────────────────────────

describe('MyPropertiesCommand', () => {
  const cmd = new MyPropertiesCommand();

  it.each(['MY_PROPERTIES', 'MY PROPERTIES', 'PROPERTIES', 'my properties'])(
    'matches landlord input "%s"',
    (input) => {
      const session = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED' }).ctx.session;
      expect(cmd.matches(input, session)).toBe(true);
    },
  );

  it('does not match tenant', () => {
    const session = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    expect(cmd.matches('MY_PROPERTIES', session)).toBe(false);
  });

  it('shows empty state when no properties', async () => {
    const client = new FakeBackendClient();
    (client as unknown as { listProperties: () => unknown }).listProperties = async () =>
      Ok({ properties: [] });
    const { ctx } = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED', jwt: 'jwt', client });
    const r = await cmd.handle(ctx, 'MY_PROPERTIES');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toMatch(/don't have any properties/i);
  });

  it('formats properties', async () => {
    const client = new FakeBackendClient();
    (client as unknown as { listProperties: () => unknown }).listProperties = async () =>
      Ok({
        properties: [
          {
            propertyId: 'p1',
            propertyCode: 'GRD-LAG-0042',
            label: 'Surulere Block A',
            address: '12 Adeniran',
            flatCount: 6,
            occupiedCount: 4,
            pendingEarningsGrd: 2.5,
          },
        ],
      });
    const { ctx } = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED', jwt: 'jwt', client });
    const r = await cmd.handle(ctx, 'MY_PROPERTIES');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('GRD-LAG-0042');
    expect(r.text).toContain('Surulere Block A');
    expect(r.text).toContain('4/6 occupied');
    expect(r.text).toContain('2.50 GRD pending');
  });
});

// ─── EarningsCommand ─────────────────────────────────────────────────────

describe('EarningsCommand', () => {
  const cmd = new EarningsCommand();

  it('matches landlord only', () => {
    const landlordSession = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED' }).ctx.session;
    const tenantSession = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    expect(cmd.matches('EARNINGS', landlordSession)).toBe(true);
    expect(cmd.matches('EARNINGS', tenantSession)).toBe(false);
  });

  it('formats earnings', async () => {
    const client = new FakeBackendClient();
    (client as unknown as { getEarnings: () => unknown }).getEarnings = async () =>
      Ok({
        pendingNgn: 12_500,
        totalEarnedNgn: 87_500,
        byProperty: [],
      });
    const { ctx } = makeCtx({ role: 'landlord', step: 'LANDLORD_AUTHENTICATED', jwt: 'jwt', client });
    const r = await cmd.handle(ctx, 'EARNINGS');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('₦12,500');
    expect(r.text).toContain('₦87,500');
  });
});

// ─── CommandRegistry ─────────────────────────────────────────────────────

describe('CommandRegistry', () => {
  it('default contains 6 commands', () => {
    const reg = CommandRegistry.default();
    expect(reg.all()).toHaveLength(6);
  });

  it('first match wins — HELP works for any role', () => {
    const reg = CommandRegistry.default();
    const tenantSession = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    expect(reg.find('HELP', tenantSession)?.id).toBe('HELP');
  });

  it('routes BALANCE to tenant command', () => {
    const reg = CommandRegistry.default();
    const tenantSession = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    expect(reg.find('BALANCE', tenantSession)?.id).toBe('BALANCE');
  });

  it('returns null when no command matches', () => {
    const reg = CommandRegistry.default();
    const session = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    expect(reg.find('definitely-not-a-command', session)).toBeNull();
  });

  it('does not route landlord commands to tenant', () => {
    const reg = CommandRegistry.default();
    const tenantSession = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' }).ctx.session;
    expect(reg.find('MY_PROPERTIES', tenantSession)).toBeNull();
    expect(reg.find('EARNINGS', tenantSession)).toBeNull();
  });

  it('handle() returns CommandResult or null', async () => {
    const reg = CommandRegistry.default();
    const { ctx } = makeCtx({ role: 'tenant', step: 'TENANT_AUTHENTICATED' });
    const r1 = await reg.handle(ctx, 'HELP');
    expect(r1?.kind).toBe('reply');
    const r2 = await reg.handle(ctx, 'gibberish');
    expect(r2).toBeNull();
  });
});
