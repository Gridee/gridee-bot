import { Command } from '../core/commands.js';
import { ScreenId } from '../core/screen-id.js';
import { renderScreen } from '../templates/index.js';
import { reply } from './flow-result.js';

export class StandardHandlers {
  constructor({ backend }) {
    this.backend = backend;
  }

  async handle({ phone, parsed, user }) {
    if (parsed.command === Command.HELP) {
      if (user?.role === 'landlord') return reply(renderScreen(ScreenId.HELP_LANDLORD));
      if (user?.role === 'tenant') return reply(renderScreen(ScreenId.HELP_TENANT));
      return reply(renderScreen(ScreenId.WELCOME_ROLE_SELECT));
    }

    if (parsed.command === Command.MY_PROPERTIES) {
      const result = await this.backend.getLandlordProperties({ landlordPhone: phone });
      return reply(renderScreen(ScreenId.MY_PROPERTIES_LIST, { properties: result.properties }));
    }

    if (parsed.command === Command.TENANTS) {
      if (!parsed.args.propertyCode) return reply('Please include a property code. Example: TENANTS GRD-LAG-0001');
      const result = await this.backend.listTenants({ landlordPhone: phone, propertyCode: parsed.args.propertyCode });
      return reply(renderScreen(ScreenId.TENANTS_LIST, { tenants: result.tenants }));
    }

    if (parsed.command === Command.EARNINGS) {
      const result = await this.backend.getLandlordEarnings({ phone });
      return reply(renderScreen(ScreenId.EARNINGS_OVERVIEW, result.earnings));
    }

    if (parsed.command === Command.BALANCE) {
      const result = await this.backend.getTenantBalance({ phone });
      return reply(renderScreen(ScreenId.BALANCE_VIEW, result.balance));
    }

    if (parsed.command === Command.HISTORY) {
      const result = await this.backend.getTenantHistory({ phone });
      return reply(renderScreen(ScreenId.HISTORY_VIEW, { transactions: result.transactions }));
    }

    if (parsed.command === Command.MY_PROPERTY) {
      const result = await this.backend.getTenantProperty({ phone });
      return reply(renderScreen(ScreenId.MY_PROPERTY_VIEW, result.property));
    }

    if (parsed.command === Command.REMOVE_TENANT) {
      if (!parsed.args.phone) return reply('Please include the tenant phone number. Example: REMOVE TENANT 2348000000000');
      const result = await this.backend.removeTenant({ phone, tenantPhone: parsed.args.phone });
      return reply(renderScreen(ScreenId.TENANT_REMOVED_LANDLORD, { name: result.tenantName, property: result.propertyName }));
    }

    if (parsed.command === Command.PROPERTY) {
      if (!parsed.args.propertyCode) return reply('Please include a property code. Example: PROPERTY GRD-LAG-0001');
      const result = await this.backend.getPropertyDetails({ phone, code: parsed.args.propertyCode });
      return reply(renderScreen(ScreenId.PROPERTY_DETAIL, {
        code: result.code,
        label: result.label,
        address: result.address,
        flatCount: result.flat_count,
        activeTenantCount: result.activeTenantCount,
        solarStatus: result.status
      }));
    }

    return null;
  }
}
