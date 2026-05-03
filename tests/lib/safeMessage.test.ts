import { describe, expect, it } from 'vitest';
import { safeMessage } from '../../src/lib/safeMessage';

describe('safeMessage', () => {
  it('returns text unchanged when within limit', () => {
    expect(safeMessage('hello')).toBe('hello');
  });

  it('returns empty string unchanged', () => {
    expect(safeMessage('')).toBe('');
  });

  it('truncates with " ..." suffix when over limit', () => {
    const long = 'x'.repeat(5000);
    const result = safeMessage(long);
    expect(result.length).toBe(4096);
    expect(result.endsWith(' ...')).toBe(true);
  });

  it('respects custom max', () => {
    const result = safeMessage('abcdefghij', 6);
    expect(result.length).toBe(6);
    expect(result).toBe('ab ...');
  });

  it('handles text exactly at the limit (no truncation)', () => {
    const exact = 'x'.repeat(4096);
    expect(safeMessage(exact)).toBe(exact);
  });

  it('handles text one over the limit (truncates)', () => {
    const over = 'x'.repeat(4097);
    const result = safeMessage(over);
    expect(result.length).toBe(4096);
  });
});
