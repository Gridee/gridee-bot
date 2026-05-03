// import { WhatsAppProvider } from './whatsapp.provider.js';
// import { normalisePhone } from '../services/phone.js';

// function escapeXml(input) {
//   return String(input)
//     .replace(/&/g, '&amp;')
//     .replace(/</g, '&lt;')
//     .replace(/>/g, '&gt;')
//     .replace(/"/g, '&quot;')
//     .replace(/'/g, '&apos;');
// }

// export class TwilioProvider extends WhatsAppProvider {
//   constructor({ config, logger }) {
//     super('twilio');
//     this.config = config;
//     this.logger = logger;
//   }

//   verifyWebhook() {
//     // Twilio request signature validation should be added before production.
//     // For local sandbox testing, this returns true.
//     return true;
//   }

//   parseInbound({ body }) {
//     const from = body.From || body.from;
//     const text = body.Body || body.body;
//     if (!from || text === undefined) return [];
//     return [
//       {
//         provider: this.name,
//         providerMessageId:
//           body.MessageSid || body.SmsMessageSid || crypto.randomUUID(),
//         phone: normalisePhone(from),
//         text: String(text).trim(),
//         profileName: body.ProfileName || null,
//         raw: body,
//       },
//     ];
//   }

//   shouldReplyWithTwiml() {
//     return this.config.replyMode === 'twiml';
//   }

//   twiml(text) {
//     return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`;
//   }

//   async sendText({ to, text }) {
//     if (this.shouldReplyWithTwiml()) {
//       this.logger.debug(
//         'Skipping Twilio API send because TWILIO_REPLY_MODE=twiml',
//       );
//       return { skipped: true };
//     }
//     if (
//       !this.config.accountSid ||
//       !this.config.authToken ||
//       !this.config.whatsappFrom
//     ) {
//       throw new Error(
//         'Twilio credentials are required when TWILIO_REPLY_MODE=api',
//       );
//     }
//     const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
//     const body = new URLSearchParams({
//       From: this.config.whatsappFrom,
//       To: `whatsapp:${normalisePhone(to)}`,
//       Body: text,
//     });
//     const auth = Buffer.from(
//       `${this.config.accountSid}:${this.config.authToken}`,
//     ).toString('base64');
//     const response = await fetch(url, {
//       method: 'POST',
//       headers: {
//         Authorization: `Basic ${auth}`,
//         'Content-Type': 'application/x-www-form-urlencoded',
//       },
//       body,
//     });
//     const payload = await response.json().catch(() => ({}));
//     if (!response.ok) {
//       throw new Error(
//         payload.message || `Twilio send failed with ${response.status}`,
//       );
//     }
//     return payload;
//   }
// }

import { randomUUID } from 'node:crypto';
import { WhatsAppProvider } from './whatsapp.provider.js';
import { normalisePhone } from '../services/phone.js';

function escapeXml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class TwilioProvider extends WhatsAppProvider {
  constructor({ config, logger }) {
    super('twilio');
    this.config = config;
    this.logger = logger;
  }

  verifyWebhook() {
    // Add Twilio request signature validation before production.
    // For local sandbox testing, this can remain true.
    return true;
  }

  parseInbound({ body }) {
    const from = body.From || body.from;
    const text = body.Body || body.body;

    if (!from || text === undefined) return [];

    return [
      {
        provider: this.name,
        providerMessageId: body.MessageSid || body.SmsMessageSid || randomUUID(),
        phone: normalisePhone(from),
        text: String(text).trim(),
        profileName: body.ProfileName || null,
        raw: body,
      },
    ];
  }

  shouldReplyWithTwiml() {
    return this.config.replyMode === 'twiml';
  }

  twiml(text) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA[${text}]]></Message></Response>`;
  }

  async sendText({ to, text }) {
    if (this.shouldReplyWithTwiml()) {
      this.logger.debug(
        'Skipping Twilio API send because TWILIO_REPLY_MODE=twiml',
      );
      return { skipped: true };
    }

    if (
      !this.config.accountSid ||
      !this.config.authToken ||
      !this.config.whatsappFrom
    ) {
      throw new Error(
        'Twilio credentials are required when TWILIO_REPLY_MODE=api',
      );
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;

    const body = new URLSearchParams({
      From: this.config.whatsappFrom,
      To: `whatsapp:${normalisePhone(to)}`,
      Body: text,
    });

    const auth = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload.message || `Twilio send failed with ${response.status}`,
      );
    }

    return payload;
  }

  async sendTemplate({ to, contentSid, variables = {} }) {
    if (
      !this.config.accountSid ||
      !this.config.authToken ||
      !this.config.whatsappFrom
    ) {
      throw new Error('Twilio credentials are required to send templates');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;

    const body = new URLSearchParams({
      From: this.config.whatsappFrom,
      To: `whatsapp:${normalisePhone(to)}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(variables),
    });

    const auth = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload.message || `Twilio template send failed with ${response.status}`,
      );
    }

    return payload;
  }
}