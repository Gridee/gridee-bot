import { ActiveCommand } from '../../core/commands.js';
import { ScreenId } from '../../core/screen-id.js';
import { normalisePhone, isValidPhone } from '../../services/phone.js';
import { isOtp, requiredText } from '../../services/validators.js';
import { renderScreen } from '../../templates/index.js';
import { reply } from '../flow-result.js';

export class LandlordRegisterFlow {
  constructor({ sessionStore, backend }) {
    this.sessionStore = sessionStore;
    this.backend = backend;
  }

  async begin(phone) {
    await this.sessionStore.set(phone, {
      role: 'landlord',
      activeCommand: ActiveCommand.LANDLORD_REGISTER,
      step: ScreenId.LANDLORD_REG_NAME,
      data: {},
    });
    return reply(renderScreen(ScreenId.LANDLORD_REG_NAME));
  }

  async continue({ phone, text, session }) {
    const data = { ...(session.data ?? {}) };

    if (session.step === ScreenId.LANDLORD_REG_NAME) {
      data.name = requiredText(text, 'Full name');
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.LANDLORD_REG_PHONE,
        data,
      });
      return reply(renderScreen(ScreenId.LANDLORD_REG_PHONE));
    }

    if (session.step === ScreenId.LANDLORD_REG_PHONE) {
      if (!isValidPhone(text)) return reply('Please enter a valid phone number. Example: 08031234567');
      data.verificationPhone = normalisePhone(text);
      await this.backend.sendOtp({ phone: data.verificationPhone, purpose: 'registration' });
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.LANDLORD_REG_OTP,
        data,
      });
      return reply(renderScreen(ScreenId.LANDLORD_REG_OTP));
    }

    if (session.step === ScreenId.LANDLORD_REG_OTP) {
      const code = String(text).trim();
      if (!isOtp(code)) return reply(renderScreen(ScreenId.ERROR_INVALID_OTP));
      const verification = await this.backend.verifyOtp({ phone: data.verificationPhone, code, purpose: 'registration' });
      if (!verification.valid) return reply(renderScreen(ScreenId.ERROR_INVALID_OTP));

      try {
        const result = await this.backend.registerLandlord({
          phone,
          name: data.name,
          verificationPhone: data.verificationPhone,
        });
        await this.sessionStore.clear(phone);
        return reply(renderScreen(ScreenId.REGISTRATION_SUCCESS, { name: result.user.name, role: 'landlord' }));
      } catch (error) {
        if (error.status === 409) {
          await this.sessionStore.clear(phone);
          return reply(renderScreen(ScreenId.ERROR_ALREADY_REGISTERED));
        }
        throw error;
      }
    }

    await this.sessionStore.clear(phone);
    return reply(renderScreen(ScreenId.SESSION_EXPIRED));
  }
}
