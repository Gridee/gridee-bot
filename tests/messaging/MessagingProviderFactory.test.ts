import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/lib/errors';
import {
  AfricasTalkingProvider,
  MessagingProviderFactory,
  TwilioProvider,
  WhatsAppCloudProvider,
} from '../../src/messaging';

describe('MessagingProviderFactory', () => {
  it('builds a Twilio provider with full config', () => {
    const provider = MessagingProviderFactory.create({
      type: 'twilio',
      twilioAccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      twilioAuthToken: 'tokensecret',
      twilioWhatsappFrom: 'whatsapp:+14155238886',
      twilioPublicWebhookUrl: 'https://api.example.com/webhook',
    });
    expect(provider).toBeInstanceOf(TwilioProvider);
    expect(provider.name).toBe('twilio');
  });

  it('builds a WhatsApp Cloud provider with full config', () => {
    const provider = MessagingProviderFactory.create({
      type: 'whatsapp_cloud',
      whatsappCloudAccessToken: 'EAAxxxxx',
      whatsappCloudPhoneNumberId: '1234567890',
      whatsappCloudAppSecret: 'appsecret',
      whatsappCloudVerifyToken: 'verifytoken',
    });
    expect(provider).toBeInstanceOf(WhatsAppCloudProvider);
    expect(provider.name).toBe('whatsapp_cloud');
  });

  it('builds an Africa\'s Talking provider with full config', () => {
    const provider = MessagingProviderFactory.create({
      type: 'africas_talking',
      atApiKey: 'k',
      atUsername: 'sandbox',
      atSenderId: 'sender',
      atWebhookSecret: 'secret',
    });
    expect(provider).toBeInstanceOf(AfricasTalkingProvider);
  });

  it('throws ConfigError when required fields are missing', () => {
    expect(() =>
      MessagingProviderFactory.create({
        type: 'twilio',
        twilioAccountSid: 'AC',
        // missing authToken, whatsappFrom, publicWebhookUrl
      }),
    ).toThrow(ConfigError);
  });

  it('throws ConfigError when fields are empty strings', () => {
    expect(() =>
      MessagingProviderFactory.create({
        type: 'whatsapp_cloud',
        whatsappCloudAccessToken: '',
        whatsappCloudPhoneNumberId: 'p',
        whatsappCloudAppSecret: 's',
        whatsappCloudVerifyToken: 'v',
      }),
    ).toThrow(ConfigError);
  });

  it('throws on unknown type at runtime', () => {
    expect(() =>
      MessagingProviderFactory.create({
        type: 'pigeon' as never,
      }),
    ).toThrow(ConfigError);
  });

  // ─── createSender — outbound-only mode ──────────────────────────────────

  describe('createSender (outbound-only)', () => {
    it('builds a sender without inbound config (Twilio)', () => {
      const sender = MessagingProviderFactory.createSender({
        type: 'twilio',
        twilioAccountSid: 'AC' + 'a'.repeat(32),
        twilioAuthToken: 'tok',
        twilioWhatsappFrom: 'whatsapp:+14155238886',
        // no twilioPublicWebhookUrl — fine for outbound-only
      });
      expect(sender.name).toBe('twilio');
    });

    it('builds a sender without inbound config (WhatsApp Cloud)', () => {
      const sender = MessagingProviderFactory.createSender({
        type: 'whatsapp_cloud',
        whatsappCloudAccessToken: 'EAA',
        whatsappCloudPhoneNumberId: '123',
        // no appSecret, no verifyToken
      });
      expect(sender.name).toBe('whatsapp_cloud');
    });

    it('still requires outbound fields', () => {
      expect(() =>
        MessagingProviderFactory.createSender({
          type: 'twilio',
          twilioAccountSid: 'AC',
          // missing authToken + whatsappFrom
        }),
      ).toThrow(ConfigError);
    });

    it('throws clear error if inbound methods are called on a sender-only provider', () => {
      // We cast back to IMessagingProvider here purely to demonstrate that
      // even if a developer bypasses the IMessageSender narrowing, the
      // runtime guard fires.
      const provider = MessagingProviderFactory.createSender({
        type: 'twilio',
        twilioAccountSid: 'AC' + 'a'.repeat(32),
        twilioAuthToken: 'tok',
        twilioWhatsappFrom: 'whatsapp:+14155238886',
      }) as unknown as TwilioProvider;
      expect(() =>
        provider.verifySignature(
          { header: () => 'sig', body: {} } as unknown as Parameters<typeof provider.verifySignature>[0],
          Buffer.alloc(0),
        ),
      ).toThrow(/outbound-only/);
    });
  });
});
