import { ActiveCommand, Command } from '../core/commands.js';
import { ScreenId } from '../core/screen-id.js';
import { renderScreen } from '../templates/index.js';
import { parseCommand } from './command-parser.js';
import { reply, noReply } from './flow-result.js';
import { OnboardingFlow } from './flows/onboarding.flow.js';
import { LandlordRegisterFlow } from './flows/landlord-register.flow.js';
import { TenantRegisterFlow } from './flows/tenant-register.flow.js';
import { AddPropertyFlow } from './flows/add-property.flow.js';
import { BuyEnergyFlow } from './flows/buy-energy.flow.js';
import { WithdrawFlow } from './flows/withdraw.flow.js';
import { RemoveTenantFlow } from './flows/remove-tenant.flow.js';
import { StandardHandlers } from './standard-handlers.js';

export class BotRouter {
  constructor({ sessionStore, idempotencyStore, backend, business, logger }) {
    this.sessionStore = sessionStore;
    this.idempotencyStore = idempotencyStore;
    this.backend = backend;
    this.logger = logger;
    this.onboardingFlow = new OnboardingFlow({ sessionStore, backend });
    this.landlordRegisterFlow = new LandlordRegisterFlow({ sessionStore, backend });
    this.tenantRegisterFlow = new TenantRegisterFlow({ sessionStore, backend });
    this.addPropertyFlow = new AddPropertyFlow({ sessionStore, backend });
    this.buyEnergyFlow = new BuyEnergyFlow({ sessionStore, backend, business });
    this.withdrawFlow = new WithdrawFlow({ sessionStore, backend });
    this.removeTenantFlow = new RemoveTenantFlow({ sessionStore, backend });
    this.standardHandlers = new StandardHandlers({ backend });
  }

  async handleInbound(message) {
    try {
      const dedupeKey = `${message.provider}:${message.providerMessageId || `${message.phone}:${message.text}`}`;
      if (await this.idempotencyStore.has(dedupeKey)) {
        this.logger.debug('Duplicate inbound message ignored', { dedupeKey });
        return noReply();
      }
      await this.idempotencyStore.remember(dedupeKey);

      const phone = message.phone;
      const text = message.text;
      const parsed = parseCommand(text);

      if (parsed.command === Command.CANCEL) {
        await this.sessionStore.clear(phone);
        return reply('Flow cancelled. Type HELP to see your options.');
      }

      const session = await this.sessionStore.get(phone);

      if (parsed.command === Command.START) {
        return this.onboardingFlow.start(phone);
      }

      if (session?.activeCommand === ActiveCommand.ROLE_SELECT) {
        return this.onboardingFlow.handleRoleSelection({ phone, parsed });
      }

      if (session) {
        return this.continueActiveFlow({ phone, text, parsed, session });
      }

      const { user } = await this.backend.resolveUser(phone);

      if (!user) {
        if (parsed.command === Command.ROLE_LANDLORD) {
          return this.onboardingFlow.handleRoleSelection({ phone, parsed });
        }
        if (parsed.command === Command.ROLE_TENANT) {
          return this.onboardingFlow.handleRoleSelection({ phone, parsed });
        }
        if (parsed.command === Command.REGISTER && parsed.args.propertyCode) {
          await this.backend.setUserRole({ phone, role: 'tenant' });
          return this.tenantRegisterFlow.begin(phone, parsed.args.propertyCode);
        }
        return this.onboardingFlow.start(phone);
      }

      if (parsed.command === Command.REGISTER) {
        return reply(renderScreen(ScreenId.ERROR_ALREADY_REGISTERED));
      }

      if (parsed.command === Command.ADD_PROPERTY) {
        if (user.role !== 'landlord') return reply('Only landlords can add properties. Type HELP to see your options.');
        return this.addPropertyFlow.begin(phone);
      }

      if (parsed.command === Command.BUY) {
        if (user.role !== 'tenant') return reply('Only tenants can buy electricity. Type HELP to see your options.');
        return this.buyEnergyFlow.begin(phone, parsed.args.amountNaira);
      }

      if (parsed.command === Command.WITHDRAW) {
        if (user.role !== 'landlord') return reply('Only landlords can withdraw earnings. Type HELP to see your options.');
        return this.withdrawFlow.begin(phone);
      }

      if (parsed.command === Command.REMOVE_TENANT) {
        if (user.role !== 'landlord') return reply('Only landlords can remove tenants. Type HELP to see your options.');
        return this.removeTenantFlow.begin(phone, parsed.args.phone);
      }

      const standard = await this.standardHandlers.handle({ phone, parsed, user });
      if (standard) return standard;

      if (parsed.command === Command.HELP) {
        return reply(user.role === 'landlord' ? renderScreen(ScreenId.HELP_LANDLORD) : renderScreen(ScreenId.HELP_TENANT));
      }

      return reply('I did not understand that. Type HELP to see your options.');
    } catch (error) {
      this.logger.error('Error handling inbound message', { error, message });
      return reply(renderScreen(ScreenId.ERROR_GENERIC));
    }
  }

  async continueActiveFlow({ phone, text, parsed, session }) {
    if (parsed.command === Command.RESEND) {
      const targetPhone = session.data?.verificationPhone || phone;
      await this.backend.sendOtp({ phone: targetPhone, purpose: 'registration' });
      return reply(renderScreen(ScreenId.ERROR_RESEND_OTP));
    }

    switch (session.activeCommand) {
      case ActiveCommand.LANDLORD_REGISTER:
        return this.landlordRegisterFlow.continue({ phone, text, session });
      case ActiveCommand.TENANT_REGISTER:
        return this.tenantRegisterFlow.continue({ phone, text, session });
      case ActiveCommand.ADD_PROPERTY:
        return this.addPropertyFlow.continue({ phone, text, session });
      case ActiveCommand.BUY:
        return this.buyEnergyFlow.continue({ phone, text, session });
      case ActiveCommand.WITHDRAW:
        return this.withdrawFlow.continue({ phone, text, session });
      case ActiveCommand.REMOVE_TENANT:
        return this.removeTenantFlow.continue({ phone, text, session });
      default:
        await this.sessionStore.clear(phone);
        return reply(renderScreen(ScreenId.SESSION_EXPIRED));
    }
  }
}
