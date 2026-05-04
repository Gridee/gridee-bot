import { ActiveCommand } from '../../core/commands.js';
import { ScreenId } from '../../core/screen-id.js';
import { renderScreen } from '../../templates/index.js';
import { reply } from '../flow-result.js';
import { normalisePhone } from '../../services/phone.js';

export class RemoveTenantFlow {
  constructor({ sessionStore, backend }) {
    this.sessionStore = sessionStore;
    this.backend = backend;
  }

  async begin(phone) {
    await this.sessionStore.set(phone, {
      role: 'landlord',
      activeCommand: ActiveCommand.REMOVE_TENANT,
      step: ScreenId.REMOVE_TENANT_PROPERTY,
      data: {},
    });
    return reply(renderScreen(ScreenId.REMOVE_TENANT_PROPERTY));
  }

  async continue({ phone, text, session }) {
    const data = { ...(session.data ?? {}) };

    if (session.step === ScreenId.REMOVE_TENANT_PROPERTY) {
      const propertyCode = text.trim().toUpperCase();
      // We could validate the property here, but for now we follow the flow
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.REMOVE_TENANT_PHONE,
        data: { ...data, propertyCode },
      });
      return reply(renderScreen(ScreenId.REMOVE_TENANT_PHONE));
    }

    if (session.step === ScreenId.REMOVE_TENANT_PHONE) {
      const tenantPhone = normalisePhone(text);
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.REMOVE_TENANT_CONFIRM,
        data: { ...data, tenantPhone },
      });
      // Use a placeholder name since we don't have it yet, or use the phone
      return reply(renderScreen(ScreenId.REMOVE_TENANT_CONFIRM, { 
        name: tenantPhone, 
        property: data.propertyCode 
      }));
    }

    if (session.step === ScreenId.REMOVE_TENANT_CONFIRM) {
      if (text.toUpperCase() === 'CONFIRM') {
        const result = await this.backend.removeTenant({ 
          phone, 
          tenantPhone: data.tenantPhone 
        });
        
        await this.sessionStore.clear(phone);
        return reply(renderScreen(ScreenId.TENANT_REMOVED_LANDLORD, { 
          name: result.tenantName, 
          property: result.propertyName 
        }));
      }
      
      if (text.toUpperCase() === 'CANCEL') {
        await this.sessionStore.clear(phone);
        return reply('Flow cancelled. Type HELP to see your options.');
      }

      return reply('Please type CONFIRM to proceed or CANCEL to stop.');
    }

    await this.sessionStore.clear(phone);
    return reply(renderScreen(ScreenId.SESSION_EXPIRED));
  }
}
