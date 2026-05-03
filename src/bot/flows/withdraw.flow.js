import { ActiveCommand } from '../../core/commands.js';
import { ScreenId } from '../../core/screen-id.js';
import { renderScreen } from '../../templates/index.js';
import { reply } from '../flow-result.js';

const CHANNELS = Object.freeze({
  '1': 'bank',
  '2': 'opay',
  '3': 'palmpay',
});

export class WithdrawFlow {
  constructor({ sessionStore, backend }) {
    this.sessionStore = sessionStore;
    this.backend = backend;
  }

  async begin(phone) {
    const bankDetails = await this.backend.getBankDetails({ phone });
    const earnings = await this.backend.getLandlordEarnings({ phone });
    if (earnings.total <= 0) {
      return reply("You don't have any earnings to withdraw yet. Type EARNINGS to check your balance.");
    }

    if (!bankDetails.accountNumber) {
      await this.sessionStore.set(phone, {
        role: 'landlord',
        activeCommand: ActiveCommand.WITHDRAW,
        step: ScreenId.WITHDRAW_BANK_INPUT,
        data: { totalEarnings: earnings.total },
      });
      return reply(renderScreen(ScreenId.WITHDRAW_BANK_INPUT));
    }

    await this.sessionStore.set(phone, {
      role: 'landlord',
      activeCommand: ActiveCommand.WITHDRAW,
      step: ScreenId.WITHDRAW_CONFIRM,
      data: {
        totalEarnings: earnings.total,
        bankName: bankDetails.bankName,
        accountNumber: bankDetails.accountNumber,
      },
    });

    return reply(renderScreen(ScreenId.WITHDRAW_CONFIRM, {
      amount: earnings.total,
      bankName: bankDetails.bankName,
      last4: bankDetails.accountNumber.slice(-4),
    }));
  }

  async continue({ phone, text, session }) {
    const data = { ...(session.data ?? {}) };

    if (session.step === ScreenId.WITHDRAW_BANK_INPUT) {
      const accountNumber = String(text).trim();
      if (!/^\d{10}$/.test(accountNumber)) {
        return reply('Please enter a valid 10-digit account number.');
      }
      data.accountNumber = accountNumber;
      await this.sessionStore.set(phone, { ...session, step: ScreenId.WITHDRAW_BANK_NAME, data });
      return reply(renderScreen(ScreenId.WITHDRAW_BANK_NAME));
    }

    if (session.step === ScreenId.WITHDRAW_BANK_NAME) {
      const bankName = String(text).trim();
      if (bankName.length < 2) return reply('Please enter a valid bank name.');
      data.bankName = bankName;

      // Save details for next time
      await this.backend.saveBankDetails({ phone, bankName, accountNumber: data.accountNumber });

      await this.sessionStore.set(phone, { ...session, step: ScreenId.WITHDRAW_CONFIRM, data });
      return reply(renderScreen(ScreenId.WITHDRAW_CONFIRM, {
        amount: data.totalEarnings,
        bankName: data.bankName,
        last4: data.accountNumber.slice(-4),
      }));
    }

    if (session.step === ScreenId.WITHDRAW_CONFIRM) {
      if (String(text).trim().toUpperCase() !== 'CONFIRM') {
        return reply('Please type CONFIRM to proceed or CANCEL to stop.');
      }

      const result = await this.backend.requestWithdrawal({ phone, amount: data.totalEarnings });
      await this.sessionStore.clear(phone);
      return reply(renderScreen(ScreenId.WITHDRAWAL_INITIATED, {
        amount: result.amount,
        bankName: result.bankName,
        last4: result.bankLast4,
      }));
    }

    await this.sessionStore.clear(phone);
    return reply(renderScreen(ScreenId.SESSION_EXPIRED));
  }
}
