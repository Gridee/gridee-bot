import { ActiveCommand } from '../../core/commands.js';
import { ScreenId } from '../../core/screen-id.js';
import { normalisePhone, isValidPhone } from '../../services/phone.js';
import { isLikelyPropertyCode, isOtp, requiredText } from '../../services/validators.js';
import { renderScreen } from '../../templates/index.js';
import { reply } from '../flow-result.js';

export class TenantRegisterFlow {
  constructor({ sessionStore, backend }) {
    this.sessionStore = sessionStore;
    this.backend = backend;
  }

  async begin(phone, initialPropertyCode) {
    await this.sessionStore.set(phone, {
      role: 'tenant',
      activeCommand: ActiveCommand.TENANT_REGISTER,
      step: ScreenId.TENANT_REG_NAME,
      data: initialPropertyCode ? { propertyCode: initialPropertyCode } : {},
    });
    return reply(renderScreen(ScreenId.TENANT_REG_NAME));
  }

  async continue({ phone, text, session }) {
    const data = { ...(session.data ?? {}) };

    if (session.step === ScreenId.TENANT_REG_NAME) {
      data.name = requiredText(text, 'Full name');
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.TENANT_REG_PHONE,
        data,
      });
      return reply(renderScreen(ScreenId.TENANT_REG_PHONE));
    }

    if (session.step === ScreenId.TENANT_REG_PHONE) {
      if (!isValidPhone(text)) return reply('Please enter a valid phone number. Example: 08031234567');
      data.verificationPhone = normalisePhone(text);
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.TENANT_REG_PROP_CODE,
        data,
      });
      return reply(renderScreen(ScreenId.TENANT_REG_PROP_CODE));
    }

    if (session.step === ScreenId.TENANT_REG_PROP_CODE) {
      const propertyCode = String(text || data.propertyCode || '').trim().toUpperCase();
      if (!isLikelyPropertyCode(propertyCode)) return reply(renderScreen(ScreenId.ERROR_INVALID_PROP_CODE));
      const validation = await this.backend.validatePropertyCode({ code: propertyCode });
      if (!validation.valid) return reply(renderScreen(ScreenId.ERROR_INVALID_PROP_CODE));

      data.propertyCode = propertyCode;
      
      // Now send OTP after property code is valid
      await this.backend.sendOtp({ phone: data.verificationPhone, purpose: 'registration' });
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.TENANT_REG_OTP,
        data,
      });
      return reply(renderScreen(ScreenId.TENANT_REG_OTP));
    }

    if (session.step === ScreenId.TENANT_REG_OTP) {
      const code = String(text).trim();
      if (!isOtp(code)) return reply(renderScreen(ScreenId.ERROR_INVALID_OTP));
      const verification = await this.backend.verifyOtp({ phone: data.verificationPhone, code, purpose: 'registration' });
      if (!verification.valid) return reply(renderScreen(ScreenId.ERROR_INVALID_OTP));

      // Register Tenant finally
      try {
        const result = await this.backend.registerTenant({
          phone,
          name: data.name,
          verificationPhone: data.verificationPhone,
          propertyCode: data.propertyCode,
        });
        await this.sessionStore.clear(phone);
        return reply(renderScreen(ScreenId.REGISTRATION_SUCCESS, { name: result.tenant.name, role: 'tenant' }));
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
