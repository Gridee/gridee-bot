import { ConfigError } from '../lib/errors';
import type { IMessageSender, IMessagingProvider } from './IMessagingProvider';
import { AfricasTalkingProvider } from './providers/AfricasTalkingProvider';
import { TwilioProvider } from './providers/TwilioProvider';
import { WhatsAppCloudProvider } from './providers/WhatsAppCloudProvider';

export type MessagingProviderType = 'twilio' | 'whatsapp_cloud' | 'africas_talking';

/**
 * Factory config.
 *
 * - Fields marked OUTBOUND are required for sending messages (used by both
 *   the bot and the backend).
 * - Fields marked INBOUND are required only for webhook reception (bot only).
 *   The backend can omit these — the factory will still construct a working
 *   provider; calling inbound methods on it would throw at runtime, which the
 *   IMessageSender narrowing prevents at compile time anyway.
 */
export interface MessagingProviderFactoryConfig {
  type: MessagingProviderType;

  // Twilio
  twilioAccountSid?: string;        // OUTBOUND
  twilioAuthToken?: string;         // OUTBOUND (also used for inbound sig verify)
  twilioWhatsappFrom?: string;      // OUTBOUND
  twilioPublicWebhookUrl?: string;  // INBOUND only

  // WhatsApp Cloud
  whatsappCloudAccessToken?: string;     // OUTBOUND
  whatsappCloudPhoneNumberId?: string;   // OUTBOUND
  whatsappCloudAppSecret?: string;       // INBOUND only
  whatsappCloudVerifyToken?: string;     // INBOUND only

  // Africa's Talking
  atApiKey?: string;            // OUTBOUND
  atUsername?: string;          // OUTBOUND
  atSenderId?: string;          // OUTBOUND
  atWebhookSecret?: string;     // INBOUND only
}

/**
 * Messaging provider factory.
 *
 * Use `create()` for the full provider (bot — needs inbound).
 * Use `createSender()` for outbound-only (backend — narrower contract).
 *
 * Both methods return the SAME instance type at runtime; the difference is
 * the static return type, which determines which methods callers can invoke.
 */
export class MessagingProviderFactory {
  /**
   * Build a full IMessagingProvider — caller must supply inbound config.
   * Use this in the bot, where webhooks are received.
   */
  static create(config: MessagingProviderFactoryConfig): IMessagingProvider {
    return buildProvider(config, /* requireInbound */ true);
  }

  /**
   * Build an outbound-only IMessageSender — inbound config can be omitted.
   * Use this in the backend, where notifications are pushed but no webhooks
   * arrive.
   */
  static createSender(config: MessagingProviderFactoryConfig): IMessageSender {
    return buildProvider(config, /* requireInbound */ false);
  }
}

function buildProvider(
  config: MessagingProviderFactoryConfig,
  requireInbound: boolean,
): IMessagingProvider {
  switch (config.type) {
    case 'twilio': {
      const outbound: Array<keyof MessagingProviderFactoryConfig> = [
        'twilioAccountSid',
        'twilioAuthToken',
        'twilioWhatsappFrom',
      ];
      const inbound: Array<keyof MessagingProviderFactoryConfig> = ['twilioPublicWebhookUrl'];
      requireFields('twilio', config, requireInbound ? [...outbound, ...inbound] : outbound);
      const opts: ConstructorParameters<typeof TwilioProvider>[0] = {
        accountSid: config.twilioAccountSid!,
        authToken: config.twilioAuthToken!,
        whatsappFrom: config.twilioWhatsappFrom!,
      };
      if (config.twilioPublicWebhookUrl) opts.publicWebhookUrl = config.twilioPublicWebhookUrl;
      return new TwilioProvider(opts);
    }

    case 'whatsapp_cloud': {
      const outbound: Array<keyof MessagingProviderFactoryConfig> = [
        'whatsappCloudAccessToken',
        'whatsappCloudPhoneNumberId',
      ];
      const inbound: Array<keyof MessagingProviderFactoryConfig> = [
        'whatsappCloudAppSecret',
        'whatsappCloudVerifyToken',
      ];
      requireFields('whatsapp_cloud', config, requireInbound ? [...outbound, ...inbound] : outbound);
      const opts: ConstructorParameters<typeof WhatsAppCloudProvider>[0] = {
        accessToken: config.whatsappCloudAccessToken!,
        phoneNumberId: config.whatsappCloudPhoneNumberId!,
      };
      if (config.whatsappCloudAppSecret) opts.appSecret = config.whatsappCloudAppSecret;
      if (config.whatsappCloudVerifyToken) opts.verifyToken = config.whatsappCloudVerifyToken;
      return new WhatsAppCloudProvider(opts);
    }

    case 'africas_talking': {
      const outbound: Array<keyof MessagingProviderFactoryConfig> = [
        'atApiKey',
        'atUsername',
        'atSenderId',
      ];
      const inbound: Array<keyof MessagingProviderFactoryConfig> = ['atWebhookSecret'];
      requireFields('africas_talking', config, requireInbound ? [...outbound, ...inbound] : outbound);
      const opts: ConstructorParameters<typeof AfricasTalkingProvider>[0] = {
        apiKey: config.atApiKey!,
        username: config.atUsername!,
        senderId: config.atSenderId!,
      };
      if (config.atWebhookSecret) opts.webhookSecret = config.atWebhookSecret;
      return new AfricasTalkingProvider(opts);
    }

    default: {
      const _exhaustive: never = config.type;
      throw new ConfigError(`Unknown messaging provider: ${String(_exhaustive)}`);
    }
  }
}

function requireFields(
  providerName: string,
  config: MessagingProviderFactoryConfig,
  fields: Array<keyof MessagingProviderFactoryConfig>,
): void {
  const missing = fields.filter((f) => {
    const v = config[f];
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required config for ${providerName} provider: ${missing.join(', ')}`,
    );
  }
}
