import { afterEach, describe, expect, it } from 'vitest';
import { _resetConfigForTests, loadConfig } from '../../src/config';
import { ConfigError } from '../../src/lib/errors';

const baseEnv: NodeJS.ProcessEnv = {
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
};

afterEach(() => {
  _resetConfigForTests();
});

describe('loadConfig — WEBHOOK_PATH', () => {
  it('defaults to /webhook when not set', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.WEBHOOK_PATH).toBe('/webhook');
  });

  it('accepts a per-provider sub-path', () => {
    const cfg = loadConfig({ ...baseEnv, WEBHOOK_PATH: '/webhook/twilio' });
    expect(cfg.WEBHOOK_PATH).toBe('/webhook/twilio');
  });

  it('rejects path that does not start with "/"', () => {
    expect(() =>
      loadConfig({ ...baseEnv, WEBHOOK_PATH: 'webhook/twilio' }),
    ).toThrow(ConfigError);
  });
});

describe('loadConfig — TWILIO_PUBLIC_WEBHOOK_URL × WEBHOOK_PATH consistency', () => {
  it('passes when URL path matches WEBHOOK_PATH', () => {
    const cfg = loadConfig({
      ...baseEnv,
      WEBHOOK_PATH: '/webhook/twilio',
      TWILIO_PUBLIC_WEBHOOK_URL: 'https://example.com/webhook/twilio',
    });
    expect(cfg.WEBHOOK_PATH).toBe('/webhook/twilio');
  });

  it('passes for the default /webhook with matching URL', () => {
    const cfg = loadConfig({
      ...baseEnv,
      TWILIO_PUBLIC_WEBHOOK_URL: 'https://example.com/webhook',
    });
    expect(cfg.WEBHOOK_PATH).toBe('/webhook');
  });

  it('rejects when URL path does not match WEBHOOK_PATH', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        WEBHOOK_PATH: '/webhook/twilio',
        TWILIO_PUBLIC_WEBHOOK_URL: 'https://example.com/webhook',
      }),
    ).toThrow(/TWILIO_PUBLIC_WEBHOOK_URL path.*does not match WEBHOOK_PATH/);
  });

  it('rejects when URL has trailing slash mismatch', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        WEBHOOK_PATH: '/webhook',
        TWILIO_PUBLIC_WEBHOOK_URL: 'https://example.com/webhook/',
      }),
    ).toThrow(ConfigError);
  });

  it('skips the consistency check when TWILIO_PUBLIC_WEBHOOK_URL is unset', () => {
    // Common dev setup: ngrok URL not set yet but bot still starts
    const cfg = loadConfig({ ...baseEnv, WEBHOOK_PATH: '/webhook/twilio' });
    expect(cfg.WEBHOOK_PATH).toBe('/webhook/twilio');
    expect(cfg.TWILIO_PUBLIC_WEBHOOK_URL).toBeUndefined();
  });
});
