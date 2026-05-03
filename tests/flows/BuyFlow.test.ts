import { describe, expect, it } from 'vitest';
import { Ok } from '../../src/client';
import { BuyFlow } from '../../src/flows';
import { apiError, errResult, makeContext } from './harness';

const flow = new BuyFlow();

describe('BuyFlow.handles', () => {
  it.each(['BUY_AMOUNT', 'BUY_CONFIRM', 'AWAITING_PAYMENT'] as const)('handles %s', (step) =>
    expect(flow.handles(step)).toBe(true),
  );

  it.each(['LANDLORD_REG_NAME', 'TENANT_AUTHENTICATED'] as const)('does not handle %s', (step) =>
    expect(flow.handles(step)).toBe(false),
  );
});

describe('BUY_AMOUNT', () => {
  it.each([
    ['2000', 2000],
    ['2,000', 2000],
    ['₦5000', 5000],
    ['5000 naira', 5000],
    [' 1000 ', 1000],
  ])('parses "%s" as %i', async (input, expected) => {
    const { ctx } = makeContext({ step: 'BUY_AMOUNT', jwt: 'jwt', role: 'tenant' });
    const result = await flow.handle(ctx, input);
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('BUY_CONFIRM');
    expect(result.patch.data?.['amountNgn']).toBe(expected);
  });

  it.each([['50'], ['99'], ['0'], ['-100'], ['2000.50'], ['hello'], ['1000001']])(
    'rejects "%s"',
    async (input) => {
      const { ctx } = makeContext({ step: 'BUY_AMOUNT', jwt: 'jwt', role: 'tenant' });
      const result = await flow.handle(ctx, input);
      expect(result.kind).toBe('stay');
    },
  );

  it('shows expected GRD on confirm screen', async () => {
    const { ctx } = makeContext({ step: 'BUY_AMOUNT', jwt: 'jwt', role: 'tenant' });
    const result = await flow.handle(ctx, '2500');
    if (result.kind !== 'advance') throw new Error('expected advance');
    // 2500 / 1250 = 2.00 GRD
    expect(result.reply).toContain('2.00 GRD');
    expect(result.reply).toContain('₦2,500');
  });
});

describe('BUY_CONFIRM', () => {
  const baseSession = {
    step: 'BUY_CONFIRM' as const,
    jwt: 'jwt',
    role: 'tenant' as const,
    data: { amountNgn: 5000 },
  };

  it('initiates BANK_TRANSFER on "1"', async () => {
    const { ctx, client } = makeContext(baseSession);
    const result = await flow.handle(ctx, '1');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.step).toBe('AWAITING_PAYMENT');
    expect(result.patch.data?.['method']).toBe('BANK_TRANSFER');
    expect(result.reply).toContain('Wema Bank');
    expect(result.reply).toContain('1234567890');
    expect(client.calls.initiatePayment).toEqual([{ amountNgn: 5000, method: 'BANK_TRANSFER' }]);
  });

  it('initiates MOBILE_MONEY on "2"', async () => {
    const { ctx, client } = makeContext(baseSession);
    client.initiatePaymentResult = Ok({
      paymentId: 'pay_2',
      txRef: 'TX_xyz',
      amountNgn: 5000,
      expectedGrd: 4.0,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      mobileMoney: { ussdCode: '*737#', provider: 'GTBank' },
    });
    const result = await flow.handle(ctx, '2');
    expect(result.kind).toBe('advance');
    if (result.kind !== 'advance') return;
    expect(result.patch.data?.['method']).toBe('MOBILE_MONEY');
    expect(result.reply).toContain('*737#');
    expect(client.calls.initiatePayment).toEqual([{ amountNgn: 5000, method: 'MOBILE_MONEY' }]);
  });

  it.each([['BANK'], ['Bank Transfer'], ['bank_transfer']])(
    'accepts bank-transfer keyword "%s"',
    async (input) => {
      const { ctx } = makeContext(baseSession);
      const result = await flow.handle(ctx, input);
      expect(result.kind).toBe('advance');
    },
  );

  it.each([['MOBILE'], ['mobile money'], ['MOBILE_MONEY']])(
    'accepts mobile-money keyword "%s"',
    async (input) => {
      const { ctx, client } = makeContext(baseSession);
      // Default fake returns bankTransfer; for these tests we need mobileMoney.
      client.initiatePaymentResult = Ok({
        paymentId: 'pay_mm',
        txRef: 'TX_mm',
        amountNgn: 5000,
        expectedGrd: 4.0,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        mobileMoney: { ussdCode: '*737#', provider: 'GTBank' },
      });
      const result = await flow.handle(ctx, input);
      expect(result.kind).toBe('advance');
    },
  );

  it.each([['3'], ['hello'], ['']])('rejects unrecognized choice "%s"', async (input) => {
    const { ctx, client } = makeContext(baseSession);
    const result = await flow.handle(ctx, input);
    expect(result.kind).toBe('stay');
    expect(client.calls.initiatePayment).toHaveLength(0);
  });

  it('resets if amountNgn is missing', async () => {
    const { ctx, client } = makeContext({
      step: 'BUY_CONFIRM',
      jwt: 'jwt',
      role: 'tenant',
      data: {},
    });
    const result = await flow.handle(ctx, '1');
    expect(result.kind).toBe('reset');
    expect(client.calls.initiatePayment).toHaveLength(0);
  });

  it('resets if jwt is missing', async () => {
    const { ctx } = makeContext({
      step: 'BUY_CONFIRM',
      role: 'tenant',
      data: { amountNgn: 5000 },
    });
    const result = await flow.handle(ctx, '1');
    expect(result.kind).toBe('reset');
  });

  it('handles backend rejection', async () => {
    const { ctx, client } = makeContext(baseSession);
    client.initiatePaymentResult = errResult(apiError('PAYMENT_INITIATION_FAILED', 502));
    const result = await flow.handle(ctx, '1');
    expect(result.kind).toBe('stay');
  });

  it('logs and falls through if BANK_TRANSFER is initiated but no bankTransfer details returned', async () => {
    const { ctx, client, capturedLogs } = makeContext(baseSession);
    client.initiatePaymentResult = Ok({
      paymentId: 'pay_x',
      txRef: 'TX_x',
      amountNgn: 5000,
      expectedGrd: 4.0,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      // bankTransfer missing!
    });
    const result = await flow.handle(ctx, '1');
    expect(result.kind).toBe('stay');
    expect(capturedLogs.some((l) => l.level === 'error')).toBe(true);
  });
});

describe('AWAITING_PAYMENT', () => {
  it('returns passthrough so dispatcher can route to commands', async () => {
    const { ctx } = makeContext({
      step: 'AWAITING_PAYMENT',
      jwt: 'jwt',
      role: 'tenant',
      data: { paymentId: 'pay_1', txRef: 'TX_abc', amountNgn: 5000 },
    });
    const result = await flow.handle(ctx, 'any message');
    expect(result.kind).toBe('passthrough');
  });
});
