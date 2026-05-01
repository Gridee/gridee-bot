import { Command } from '../core/commands.js';
import { parseMoneyAmount } from '../services/validators.js';

function clean(input) {
  return String(input ?? '').trim().replace(/\s+/g, ' ');
}

export function parseCommand(text) {
  const raw = clean(text);
  const upper = raw.toUpperCase();

  if (!raw) return { command: Command.UNKNOWN, raw, args: {} };
  if (['HI', 'HELLO', 'START', '/START', 'MENU'].includes(upper)) return { command: Command.START, raw, args: {} };
  if (['HELP', '?'].includes(upper)) return { command: Command.HELP, raw, args: {} };
  if (['CANCEL', 'STOP', 'EXIT'].includes(upper)) return { command: Command.CANCEL, raw, args: {} };
  if (upper === 'RESEND') return { command: Command.RESEND, raw, args: {} };
  if (upper === '1' || upper === 'LANDLORD') return { command: Command.ROLE_LANDLORD, raw, args: {} };
  if (upper === '2' || upper === 'TENANT') return { command: Command.ROLE_TENANT, raw, args: {} };
  if (upper === 'REGISTER') return { command: Command.REGISTER, raw, args: {} };
  if (upper.startsWith('REGISTER ')) return { command: Command.REGISTER, raw, args: { propertyCode: raw.split(' ')[1]?.toUpperCase() } };

  if (upper === 'ADD PROPERTY' || upper === 'NEW PROPERTY') return { command: Command.ADD_PROPERTY, raw, args: {} };
  if (upper === 'MY PROPERTIES' || upper === 'PROPERTIES') return { command: Command.MY_PROPERTIES, raw, args: {} };
  if (upper.startsWith('TENANTS')) return { command: Command.TENANTS, raw, args: { propertyCode: raw.split(' ')[1]?.toUpperCase() } };
  if (upper.startsWith('PROPERTY ')) return { command: Command.PROPERTY, raw, args: { propertyCode: raw.split(' ')[1]?.toUpperCase() } };
  if (upper === 'EARNINGS' || upper === 'BALANCE LANDLORD') return { command: Command.EARNINGS, raw, args: {} };
  if (upper === 'WITHDRAW') return { command: Command.WITHDRAW, raw, args: {} };
  if (upper.startsWith('REMOVE TENANT')) return { command: Command.REMOVE_TENANT, raw, args: { phone: raw.split(' ')[2] } };

  if (upper === 'BALANCE') return { command: Command.BALANCE, raw, args: {} };
  if (upper === 'STATUS') return { command: Command.STATUS, raw, args: {} };
  if (upper === 'HISTORY') return { command: Command.HISTORY, raw, args: {} };
  if (upper === 'MY PROPERTY') return { command: Command.MY_PROPERTY, raw, args: {} };
  if (upper === 'BUY' || upper === 'TOPUP') return { command: Command.BUY, raw, args: {} };
  if (upper.startsWith('BUY ') || upper.startsWith('TOPUP ')) {
    const amountText = raw.split(' ')[1];
    try {
      return { command: Command.BUY, raw, args: { amountNaira: parseMoneyAmount(amountText) } };
    } catch {
      return { command: Command.BUY, raw, args: {} };
    }
  }

  return { command: Command.UNKNOWN, raw, args: {} };
}
