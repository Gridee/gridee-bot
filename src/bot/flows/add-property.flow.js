import { ActiveCommand } from '../../core/commands.js';
import { ScreenId } from '../../core/screen-id.js';
import { parsePositiveInt, requiredText } from '../../services/validators.js';
import { renderScreen } from '../../templates/index.js';
import { reply } from '../flow-result.js';

export class AddPropertyFlow {
  constructor({ sessionStore, backend }) {
    this.sessionStore = sessionStore;
    this.backend = backend;
  }

  async begin(phone) {
    await this.sessionStore.set(phone, {
      role: 'landlord',
      activeCommand: ActiveCommand.ADD_PROPERTY,
      step: ScreenId.ADD_PROPERTY_ADDRESS,
      data: {},
    });
    return reply(renderScreen(ScreenId.ADD_PROPERTY_ADDRESS));
  }

  async continue({ phone, text, session }) {
    const data = { ...(session.data ?? {}) };

    if (session.step === ScreenId.ADD_PROPERTY_ADDRESS) {
      data.address = requiredText(text, 'Property address');
      await this.sessionStore.set(phone, { ...session, step: ScreenId.ADD_PROPERTY_FLAT_COUNT, data });
      return reply(renderScreen(ScreenId.ADD_PROPERTY_FLAT_COUNT));
    }

    if (session.step === ScreenId.ADD_PROPERTY_FLAT_COUNT) {
      try {
        data.flatCount = parsePositiveInt(text, 'Flat count');
      } catch {
        return reply('Please enter a valid number of flats/units. Example: 8');
      }
      await this.sessionStore.set(phone, { ...session, step: ScreenId.ADD_PROPERTY_LABEL, data });
      return reply(renderScreen(ScreenId.ADD_PROPERTY_LABEL));
    }

    if (session.step === ScreenId.ADD_PROPERTY_LABEL) {
      data.label = requiredText(text, 'Property label');
      const result = await this.backend.createProperty({
        phone,
        address: data.address,
        flatCount: data.flatCount,
        label: data.label,
      });
      await this.sessionStore.clear(phone);
      return reply(renderScreen(ScreenId.PROPERTY_REGISTERED, {
        code: result.code,
        label: result.label,
      }));
    }

    await this.sessionStore.clear(phone);
    return reply(renderScreen(ScreenId.SESSION_EXPIRED));
  }
}
