import { describe, expect, it, vi } from 'vitest';
import { BackendClient } from '../../src/client/BackendClient';
import {
  BackendApiError,
  BackendContractError,
} from '../../src/client/errors';

const BASE_URL = 'https://api.example.test';

function makeClient(fetchImpl: typeof fetch): BackendClient {
  return new BackendClient({
    baseUrl: BASE_URL,
    fetchImpl,
    sleepImpl: async () => undefined,
    retryBaseDelayMs: 1,
    maxRetries: 0,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Request validation
// ─────────────────────────────────────────────────────────────────────────────

describe('BackendClient — request validation', () => {
  it('rejects an invalid phone before sending (does not call fetch)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.registerLandlord({
      fullName: 'Lola Adeyemi',
      phone: 'not-a-phone',
    } as unknown as Parameters<typeof client.registerLandlord>[0]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendContractError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a too-short fullName before sending', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.registerLandlord({
      fullName: 'L',
      phone: '+2348031234567',
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects withdraw with non-10-digit account', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.withdraw('jwt', {
      amountNgn: 5000,
      bankAccountNumber: '12345',
      bankCode: '044',
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response validation — contract drift detection
// ─────────────────────────────────────────────────────────────────────────────

describe('BackendClient — response validation (contract drift)', () => {
  it('catches missing fields in response', async () => {
    // Backend forgets `expiresAt` — drift!
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { otpRef: 'ref-123' }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.registerLandlord({
      fullName: 'Lola Adeyemi',
      phone: '+2348031234567',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendContractError);
    expect((result.error as BackendContractError).endpoint).toBe(
      '/api/auth/landlord/register',
    );
  });

  it('catches type drift (string instead of number)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        balanceGrd: '5.5', // ← should be number
        estimatedDaysRemaining: 11,
        status: 'CONNECTED',
        lastUpdatedAt: '2026-05-01T10:00:00.000Z',
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.getBalance('jwt-tok');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendContractError);
  });

  it('passes valid responses through (positive case)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        otpRef: 'ref-abc',
        expiresAt: '2026-05-01T10:30:00.000Z',
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.registerLandlord({
      fullName: 'Lola Adeyemi',
      phone: '+2348031234567',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.otpRef).toBe('ref-abc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth handling
// ─────────────────────────────────────────────────────────────────────────────

describe('BackendClient — auth', () => {
  it('attaches Bearer JWT on authenticated calls', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        balanceGrd: 5.5,
        estimatedDaysRemaining: 11,
        status: 'CONNECTED',
        lastUpdatedAt: '2026-05-01T10:00:00.000Z',
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.getBalance('my-jwt-token');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-jwt-token');
  });

  it('does NOT attach Authorization on public registration', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        otpRef: 'r',
        expiresAt: '2026-05-01T10:30:00.000Z',
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.registerLandlord({
      fullName: 'Lola Adeyemi',
      phone: '+2348031234567',
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end flows
// ─────────────────────────────────────────────────────────────────────────────

describe('BackendClient — end-to-end flow examples', () => {
  it('OTP verification returns typed response', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        jwt: 'jwt.tok.en',
        userId: 'usr_1',
        role: 'landlord',
        expiresAt: '2026-05-01T11:00:00.000Z',
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.verifyOtp({ otpRef: 'ref', otp: '123456' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe('landlord');
    expect(result.value.jwt).toBe('jwt.tok.en');
  });

  it('payment initiation with bank transfer details', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        paymentId: 'pay_1',
        txRef: 'TX_abc',
        amountNgn: 5000,
        expectedGrd: 4.0,
        expiresAt: '2026-05-01T10:15:00.000Z',
        bankTransfer: {
          accountNumber: '1234567890',
          accountName: 'Gridee Wallet',
          bankName: 'Wema Bank',
        },
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.initiatePayment('jwt', {
      amountNgn: 5000,
      method: 'BANK_TRANSFER',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bankTransfer?.accountNumber).toBe('1234567890');
    expect(result.value.expectedGrd).toBe(4.0);
  });

  it('returns BackendApiError with code on validation failure', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, {
        error: { code: 'INVALID_OTP', message: 'Wrong OTP', details: { attemptsLeft: 2 } },
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.verifyOtp({ otpRef: 'ref', otp: '000000' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendApiError);
    const err = result.error as BackendApiError;
    expect(err.code).toBe('INVALID_OTP');
  });

  it('listProperties returns array with all summary fields', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        properties: [
          {
            propertyId: 'p1',
            propertyCode: 'GRD-LAG-0042',
            label: 'Surulere Block A',
            address: '123 Adeniran St',
            flatCount: 6,
            occupiedCount: 4,
            pendingEarningsGrd: 2.5,
          },
        ],
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const result = await client.listProperties('jwt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.properties).toHaveLength(1);
    expect(result.value.properties[0]!.propertyCode).toBe('GRD-LAG-0042');
  });
});
