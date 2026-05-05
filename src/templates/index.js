import { ScreenId, INTERNAL_SCREEN_IDS, ALL_SCREEN_IDS } from '../core/screen-id.js';

const NAIRA = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });

function money(value) {
  return NAIRA.format(Number(value || 0));
}

function hours(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return 'N/A';
  return `${Number(value).toFixed(1)} hours`;
}

function listLines(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0) return emptyText;
  return items.join('\n');
}

export const templates = Object.freeze({
  [ScreenId.WELCOME_ROLE_SELECT]: () => `Welcome to Gridee ⚡\n\nAre you a:\n1. Landlord\n2. Tenant`,
  [ScreenId.ROLE_PROMPT]: () => templates[ScreenId.WELCOME_ROLE_SELECT](),

  [ScreenId.LANDLORD_REG_NAME]: () => 'What is your full name?',
  [ScreenId.LANDLORD_REG_PHONE]: () => 'Enter your phone number for verification.',
  [ScreenId.LANDLORD_REG_OTP]: () => 'Enter the 6-digit OTP sent to your number.',

  [ScreenId.TENANT_REG_NAME]: () => 'What is your full name?',
  [ScreenId.TENANT_REG_PHONE]: () => 'Enter your phone number for verification.',
  [ScreenId.TENANT_REG_OTP]: () => 'Enter the OTP sent to your number.',
  [ScreenId.TENANT_REG_PROP_CODE]: () => 'Enter the Property Code your landlord gave you.\n\nExample: GRD-LAG-0042',

  [ScreenId.HELP_LANDLORD]: () => `Gridee Landlord Menu ⚡\n\nADD PROPERTY - Register a property\nMY PROPERTIES - View your properties\nTENANTS [code] - View tenants\nREMOVE TENANT - Remove a tenant\nEARNINGS - View earnings\nWITHDRAW - Request payout\nHELP - Show this menu`,
  [ScreenId.HELP_TENANT]: () => `Gridee Tenant Menu ⚡\n\nBUY [amount] - Buy electricity\nBALANCE - Check your balance\nHISTORY - View transactions\nMY PROPERTY - View your property\nHELP - Show this menu`,

  [ScreenId.ERROR_GENERIC]: () => 'Something went wrong. Please try again or type HELP.',
  [ScreenId.ERROR_INVALID_OTP]: () => 'Incorrect OTP. Try again or type RESEND to get a new one.',
  [ScreenId.ERROR_OTP_EXPIRED]: () => 'Your OTP has expired. Type RESEND to get a new one.',
  [ScreenId.ERROR_RESEND_OTP]: () => 'A new OTP has been sent to your number. Valid for 5 minutes.',
  [ScreenId.ERROR_ALREADY_REGISTERED]: () => 'You already have an account. Type HELP to see your options.',
  [ScreenId.ERROR_INVALID_PROP_CODE]: () => "That Property Code wasn't found. Please check with your landlord and try again.",
  [ScreenId.SESSION_EXPIRED]: () => 'Your session has expired. Type START to begin again.',
  [ScreenId.ALREADY_REGISTERED]: () => templates[ScreenId.ERROR_ALREADY_REGISTERED](),

  BUY_AMOUNT: () => 'How much would you like to spend?\n\nEnter amount in NGN. Example: BUY 2000',
  [ScreenId.BUY_PROP_CODE]: () => 'Which property are you buying for? Enter the Property Code (e.g. GRD-LAG-0042):',
  [ScreenId.BUY_CONFIRM]: ({ amountNaira, grdAmount, kwhAmount }) => `You're buying ${Number(grdAmount).toFixed(2)} GRD for ${money(amountNaira)} — roughly ${Number(kwhAmount).toFixed(2)} kWh.\n\nChoose a payment method:\n1. Bank Transfer\n2. Mobile Money\n3. Crypto`,
  [ScreenId.PAYMENT_INSTRUCTIONS_BANK]: ({ amountNaira, bankName, accountNumber, accountName, reference, expiresInMinutes = 15 }) => `Transfer ${money(amountNaira)} to:\n\nBank: ${bankName}\nAccount: ${accountNumber}\nName: ${accountName}\nReference: ${reference}\n\nThis account expires in ${expiresInMinutes} minutes.`,
  [ScreenId.PAYMENT_INSTRUCTIONS_MOBILE_MONEY]: ({ amountNaira, network, reference }) => `Pay ${money(amountNaira)} using ${network}.\n\nReference: ${reference}\n\nYou will receive confirmation once payment is complete.`,
  [ScreenId.PAYMENT_INSTRUCTIONS_CRYPTO]: ({ usdtAmount, walletAddress, reference }) => `Send ${usdtAmount} USDT to:\n\n${walletAddress}\n\nReference: ${reference}\n\nYou will receive confirmation once payment is complete.`,
  [ScreenId.PAYMENT_CONFIRMED]: ({ grdAmount, newBalance, estimatedHours }) => `✅ Payment confirmed! ${Number(grdAmount).toFixed(2)} GRD added to your account.\n\nNew balance: ${Number(newBalance).toFixed(2)} GRD (≈ ${hours(estimatedHours)}).`,
  [ScreenId.PAYMENT_EXPIRED]: () => 'Your payment window expired. Type BUY [amount] to try again.',
  [ScreenId.PAYMENT_FAILED]: ({ reason = 'Please try again' } = {}) => `Your payment could not be processed. ${reason}. Type BUY [amount] to try again.`,

  [ScreenId.BALANCE_VIEW]: ({ balanceGrd, estimatedHours, propertyName, lastTopupDate }) => `Your Gridee balance: ${Number(balanceGrd).toFixed(2)} GRD ≈ ${hours(estimatedHours)} of average usage.\n\nProperty: ${propertyName || 'N/A'}\nLast topped up: ${lastTopupDate || 'N/A'}`,
  [ScreenId.HISTORY_VIEW]: ({ transactions = [] }) => {
    const lines = transactions.map((tx, index) => `${index + 1}. ${tx.date} — ${money(tx.amountNaira)} — +${Number(tx.grdAmount).toFixed(2)} GRD`);
    return `Recent transactions:\n\n${listLines(lines, 'No transactions yet.')}`;
  },
  [ScreenId.MY_PROPERTY_VIEW]: ({ label, address, landlordName, status }) => `Your property:\n\n${label}\n${address}\nLandlord: ${landlordName}\nStatus: ${status}`,

  [ScreenId.MY_PROPERTIES_LIST]: ({ properties = [] }) => {
    const lines = properties.map((property, index) => `${index + 1}. ${property.label}\nCode: ${property.code} | Flats: ${property.flatCount} | Active tenants: ${property.activeTenantCount ?? 0}`);
    return `Your registered properties:\n\n${listLines(lines, 'You have not registered any property yet. Type ADD PROPERTY to begin.')}`;
  },
  [ScreenId.ADD_PROPERTY_ADDRESS]: () => 'Enter the property address (street, area, state):',
  [ScreenId.ADD_PROPERTY_FLAT_COUNT]: () => 'How many rentable flats/units are in this compound?',
  [ScreenId.ADD_PROPERTY_LABEL]: () => 'Give this property a short name.\n\nExample: Surulere Block A',
  [ScreenId.PROPERTY_REGISTERED]: ({ code, label }) => `Property registered! Your code is ${code}. Share it with your tenants.`,
  [ScreenId.PROPERTY_DETAIL]: ({ code, label, address, flatCount, activeTenantCount, solarStatus }) => `Code: ${code}\nLabel: ${label}\nAddress: ${address}\nFlat count: ${flatCount}\nActive tenant count: ${activeTenantCount}\nSolar status: ${solarStatus}`,
  [ScreenId.TENANTS_LIST]: ({ tenants = [] }) => {
    const lines = tenants.map((tenant, index) => {
      const flat = tenant.flatNumber ? ` — ${tenant.flatNumber}` : '';
      return `${index + 1}. ${tenant.name}${flat} — ${tenant.status}`;
    });
    return `Tenants:\n\n${listLines(lines, 'No tenants registered under this property yet.')}`;
  },

  [ScreenId.EARNINGS_OVERVIEW]: ({ totalEarnings, propertyCount, breakdown = [] }) => {
    const lines = breakdown.map((item) => `${item.code}: ${money(item.amount)}`);
    return `Total earnings: ${money(totalEarnings)} across ${propertyCount} properties.\n\n${listLines(lines, 'No property earnings yet.')}`;
  },
  [ScreenId.EARNINGS_PROPERTY]: ({ code, amount, purchases }) => `Earnings for ${code}:\n\nTotal: ${money(amount)}\nPurchases: ${purchases}`,
  [ScreenId.WITHDRAW_BANK_INPUT]: () => 'Enter bank account number:',
  [ScreenId.WITHDRAW_BANK_NAME]: () => 'Enter bank name:',
  [ScreenId.WITHDRAW_CONFIRM]: ({ amount, bankName, last4 }) => `Withdraw ${money(amount)} to ${bankName} ****${last4}?`,
  [ScreenId.WITHDRAWAL_INITIATED]: () => `Withdrawal initiated. Funds arrive within 2 hours.`,

  [ScreenId.REMOVE_TENANT_PROPERTY]: () => 'Enter Property Code:',
  [ScreenId.REMOVE_TENANT_PHONE]: () => 'Enter the phone number of the tenant you want to remove:',
  [ScreenId.REMOVE_TENANT_CONFIRM]: ({ name, property }) => `Remove ${name} from ${property}? This stops their solar access.`,
  [ScreenId.TENANT_REMOVED_LANDLORD]: ({ name, property }) => `Done. ${name} has been removed from ${property} and their solar access has stopped.`,

  [ScreenId.ALERT_LOW_BALANCE]: ({ balance }) => `⚠️ Low Energy Alert! Your balance is below 1 kWh (${balance} GRD left). Type BUY [amount] to top up now.`,
  [ScreenId.ALERT_CUTOFF]: () => '⚡ Your solar access has been paused — your Gridee balance is empty. Type BUY [amount] to restore power.',
  [ScreenId.ALERT_RESTORED]: ({ newBalance, estimatedHours }) => `✅ Power restored! Your solar is back on. New balance: ${newBalance} GRD (≈ ${hours(estimatedHours)}).`,
  [ScreenId.NOTIFY_NEW_TENANT]: ({ name, code }) => `New tenant ${name} has registered under your property ${code}.`,
  [ScreenId.NOTIFY_PURCHASE_CONFIRMED]: (data) => templates[ScreenId.PAYMENT_CONFIRMED](data),
  [ScreenId.NOTIFY_WITHDRAWAL_CONFIRMED]: ({ amount, bankName }) => `✅ ${money(amount)} has been sent to your ${bankName} account. Expect it within 2 hours.`,
  [ScreenId.NOTIFY_TENANT_REMOVED]: ({ propertyName }) => `You have been removed from ${propertyName}. Contact your landlord for more information.`,

  [ScreenId.OTP_SENT]: ({ code }) => `Your Gridee verification code is: ${code}. Valid for 5 minutes. Do not share this code.`,
  [ScreenId.OTP_INVALID]: () => "Incorrect code. That OTP doesn't match what we sent. Type RESEND for a new one.",
  [ScreenId.OTP_RESENT]: () => 'A new verification code has been sent to your number. Valid for 5 minutes.',

  [ScreenId.REGISTRATION_SUCCESS]: ({ name, role }) => {
    const next = role === 'landlord' ? 'Type ADD PROPERTY to register your first property.' : 'Type BUY 2000 to buy electricity or HELP to see your options.';
    return `Registration successful ✅\n\nWelcome, ${name}. You are now registered as a ${role}.\n\n${next}`;
  },
});

export function renderScreen(screenId, data = {}) {
  if (INTERNAL_SCREEN_IDS.has(screenId)) {
    throw new Error(`Screen ${screenId} is internal and should not be rendered directly`);
  }
  const template = templates[screenId];
  if (!template) throw new Error(`No template registered for screen ${screenId}`);
  const output = template(data);
  if (typeof output !== 'string' || output.trim() === '') {
    throw new Error(`Template ${screenId} returned an empty message`);
  }
  if (output.length > 4096) {
    throw new Error(`Template ${screenId} exceeds WhatsApp 4096 character limit`);
  }
  return output;
}

export function getMissingTemplateScreenIds() {
  return ALL_SCREEN_IDS.filter((screenId) => !INTERNAL_SCREEN_IDS.has(screenId) && !templates[screenId]);
}
