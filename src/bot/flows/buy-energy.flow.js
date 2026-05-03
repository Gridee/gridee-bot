import { ActiveCommand } from '../../core/commands.js';
import { ScreenId } from '../../core/screen-id.js';
import { parseMoneyAmount } from '../../services/validators.js';
import { renderScreen } from '../../templates/index.js';
import { reply } from '../flow-result.js';

const PAYMENT_METHODS = Object.freeze({
  '1': 'bank_transfer',
  '2': 'mobile_money',
  '3': 'crypto',
  'bank transfer': 'bank_transfer',
  'bank': 'bank_transfer',
  'mobile money': 'mobile_money',
  'mobile': 'mobile_money',
  'crypto': 'crypto',
  'cryptocurrency': 'crypto',
});

export class BuyEnergyFlow {
  constructor({ sessionStore, backend, business }) {
    this.sessionStore = sessionStore;
    this.backend = backend;
    this.business = business;
  }

  async begin(phone, amountNaira) {
    if (!amountNaira) {
      await this.sessionStore.set(phone, {
        role: 'tenant',
        activeCommand: ActiveCommand.BUY,
        step: ScreenId.BUY_AMOUNT,
        data: {},
      });
      return reply(renderScreen(ScreenId.BUY_AMOUNT));
    }
    return this.setAmountAndAskPaymentMethod(phone, amountNaira, {});
  }

  async setAmountAndAskPaymentMethod(phone, amountNaira, currentData) {
    if (amountNaira < this.business.minTopupNaira) {
      return reply(`Minimum top-up is ₦${this.business.minTopupNaira}. Please type BUY ${this.business.minTopupNaira} or higher.`);
    }
    const kwhAmount = amountNaira / this.business.kwhRateNaira;
    const grdAmount = kwhAmount;
    const data = { ...currentData, amountNaira, kwhAmount, grdAmount };
    await this.sessionStore.set(phone, {
      role: 'tenant',
      activeCommand: ActiveCommand.BUY,
      step: ScreenId.BUY_CONFIRM,
      data,
    });
    return reply(renderScreen(ScreenId.BUY_CONFIRM, data));
  }

  async continue({ phone, text, session }) {
    const data = { ...(session.data ?? {}) };

    if (session.step === ScreenId.BUY_AMOUNT) {
      let amountNaira;
      try {
        amountNaira = parseMoneyAmount(text, 'Top-up amount');
      } catch {
        return reply('Please enter a valid amount. Example: 2000');
      }
      return this.setAmountAndAskPaymentMethod(phone, amountNaira, data);
    }

    if (session.step === ScreenId.BUY_CONFIRM) {
      const selected = String(text).trim().toLowerCase();
      const paymentMethod = PAYMENT_METHODS[selected];
      if (!paymentMethod) return reply('Please choose a payment method:\n1. Bank Transfer\n2. Mobile Money\n3. Crypto');

      const result = await this.backend.createPaymentIntent({
        tenantPhone: phone,
        amountNaira: data.amountNaira,
        paymentMethod,
      });
      await this.sessionStore.set(phone, {
        ...session,
        step: ScreenId.AWAITING_PAYMENT,
        data: { ...data, reference: result.payment.reference, paymentMethod },
      });

      if (paymentMethod === 'bank_transfer') {
        return reply(renderScreen(ScreenId.PAYMENT_INSTRUCTIONS_BANK, result.payment));
      }
      if (paymentMethod === 'mobile_money') {
        return reply(renderScreen(ScreenId.PAYMENT_INSTRUCTIONS_MOBILE_MONEY, result.payment));
      }
      return reply(renderScreen(ScreenId.PAYMENT_INSTRUCTIONS_CRYPTO, result.payment));
    }

    if (session.step === ScreenId.AWAITING_PAYMENT) {
      return reply('Your payment is still pending. I will notify you once it is confirmed. Type CANCEL to stop this flow.');
    }

    await this.sessionStore.clear(phone);
    return reply(renderScreen(ScreenId.SESSION_EXPIRED));
  }
}
