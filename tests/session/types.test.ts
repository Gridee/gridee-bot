import { describe, expect, it } from 'vitest';
import { Phone, SessionStateSchema, SessionStepSchema, SCREEN_IDS, SESSION_STEPS, newSessionState } from '../../src/session/types';

describe('Phone brand', () => {
  it('accepts valid E.164', () => {
    const p = Phone.of('+2348031234567');
    expect(p).toBe('+2348031234567');
  });

  it.each([
    '2348031234567',         // missing +
    '+0348031234567',        // leading zero on country code
    '+1234',                 // too short
    '+1234567890123456',     // too long
    'not-a-phone',
    '',
  ])('rejects invalid format: %s', (bad) => {
    expect(() => Phone.of(bad)).toThrow();
  });
});

describe('SessionStep enum', () => {
  it('every session step is also a valid screen id', () => {
    for (const step of SESSION_STEPS) {
      expect(SCREEN_IDS).toContain(step);
    }
  });

  it('rejects steps that are notification-only', () => {
    expect(SessionStepSchema.safeParse('ALERT_LOW_BALANCE').success).toBe(false);
    expect(SessionStepSchema.safeParse('NOTIFY_NEW_TENANT').success).toBe(false);
    expect(SessionStepSchema.safeParse('PAYMENT_CONFIRMED').success).toBe(false);
  });

  it('accepts the post-onboarding authenticated steps', () => {
    expect(SessionStepSchema.safeParse('LANDLORD_AUTHENTICATED').success).toBe(true);
    expect(SessionStepSchema.safeParse('TENANT_AUTHENTICATED').success).toBe(true);
  });
});

describe('newSessionState', () => {
  it('initializes timestamps and defaults', () => {
    const s = newSessionState({ step: 'WELCOME_ROLE_SELECT' });
    expect(s.role).toBeNull();
    expect(s.data).toEqual({});
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.updatedAt).toBe(s.createdAt);
  });

  it('omits jwt/userId when not provided (does not include undefined)', () => {
    const s = newSessionState({ step: 'WELCOME_ROLE_SELECT' });
    expect('jwt' in s).toBe(false);
    expect('userId' in s).toBe(false);
  });

  it('includes jwt/userId when provided', () => {
    const s = newSessionState({ step: 'LANDLORD_AUTHENTICATED', role: 'landlord', jwt: 'abc.def.ghi', userId: 'usr_1' });
    expect(s.jwt).toBe('abc.def.ghi');
    expect(s.userId).toBe('usr_1');
  });

  it('passes schema validation', () => {
    const s = newSessionState({ step: 'BUY_AMOUNT', role: 'tenant' });
    expect(SessionStateSchema.safeParse(s).success).toBe(true);
  });
});
