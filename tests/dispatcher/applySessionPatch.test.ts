import { describe, expect, it } from 'vitest';
import { applySessionPatch } from '../../src/dispatcher/applySessionPatch';
import { newSessionState } from '../../src/session/types';

describe('applySessionPatch', () => {
  const base = (): ReturnType<typeof newSessionState> => ({
    ...newSessionState({ step: 'WELCOME_ROLE_SELECT' }),
    data: { existing: 'value' },
  });

  it('replaces step', () => {
    const next = applySessionPatch(base(), { step: 'LANDLORD_REG_NAME' });
    expect(next.step).toBe('LANDLORD_REG_NAME');
  });

  it('shallow-merges data by default', () => {
    const next = applySessionPatch(base(), { data: { newKey: 'newValue' } });
    expect(next.data).toEqual({ existing: 'value', newKey: 'newValue' });
  });

  it('replaces data entirely with clearData=true', () => {
    const next = applySessionPatch(base(), { clearData: true, data: { fresh: 1 } });
    expect(next.data).toEqual({ fresh: 1 });
  });

  it('clearData with no data field empties data', () => {
    const next = applySessionPatch(base(), { clearData: true });
    expect(next.data).toEqual({});
  });

  it('sets jwt and userId', () => {
    const next = applySessionPatch(base(), { jwt: 'abc', userId: 'usr_1' });
    expect(next.jwt).toBe('abc');
    expect(next.userId).toBe('usr_1');
  });

  it('clears jwt with jwtClear=true', () => {
    const session = { ...base(), jwt: 'old' };
    const next = applySessionPatch(session, { jwtClear: true });
    expect(next.jwt).toBeUndefined();
  });

  it('jwtClear takes precedence over jwt field in same patch', () => {
    const session = { ...base(), jwt: 'old' };
    const next = applySessionPatch(session, { jwtClear: true, jwt: 'should-be-ignored' });
    expect(next.jwt).toBeUndefined();
  });

  it('does not mutate the input session', () => {
    const session = base();
    const before = JSON.stringify(session);
    applySessionPatch(session, { step: 'LANDLORD_REG_NAME', data: { x: 1 } });
    expect(JSON.stringify(session)).toBe(before);
  });

  it('preserves createdAt; bumps updatedAt', async () => {
    const session = base();
    const created = session.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    const next = applySessionPatch(session, { step: 'LANDLORD_REG_NAME' });
    expect(next.createdAt).toBe(created);
    expect(next.updatedAt).toBeGreaterThanOrEqual(created);
  });

  it('preserves role unless explicitly set', () => {
    const session = { ...base(), role: 'landlord' as const };
    const next = applySessionPatch(session, { step: 'LANDLORD_REG_NAME' });
    expect(next.role).toBe('landlord');
  });

  it('updates role when set in patch', () => {
    const next = applySessionPatch(base(), { role: 'tenant' });
    expect(next.role).toBe('tenant');
  });

  it('explicitly setting role to null clears it', () => {
    const session = { ...base(), role: 'landlord' as const };
    const next = applySessionPatch(session, { role: null });
    expect(next.role).toBeNull();
  });
});
