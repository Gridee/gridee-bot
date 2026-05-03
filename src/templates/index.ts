/**
 * User-facing copy templates.
 *
 * OWNERSHIP: Mark David owns the production copy. This file ships a default
 * implementation that the bot uses today; when Mark's templates module
 * lands, it should implement the same `ITemplates` interface so the bot
 * can swap providers via DI without touching flow code.
 *
 * Convention from SCREENS.md:
 *   - Every screen ID has a corresponding template method
 *   - Templates ALWAYS return strings (never compose with provider code)
 *   - Bot code never composes user-facing strings inline — it must go
 *     through this module so localization (English / Pidgin) is uniform
 *   - safeMessage() truncation is applied at the sender, not here
 */

export interface ITemplates {
  // Welcome / role selection
  rolePrompt(): string;

  // Landlord registration
  landlordRegName(): string;
  landlordRegPhone(): string;
  landlordRegOtp(): string;

  // Tenant registration
  tenantRegName(): string;
  tenantRegPhone(): string;
  tenantRegOtp(): string;
  tenantRegPropCode(): string;

  // ADD PROPERTY (chained after landlord auth)
  addPropertyAddress(): string;
  addPropertyFlatCount(): string;
  addPropertyLabel(): string;
  propertyRegistered(args: { propertyCode: string; label: string }): string;

  // Welcome / success
  welcomeAuthenticated(args: { fullName: string; role: 'landlord' | 'tenant' }): string;
  tenantOnboardingComplete(args: { propertyLabel: string; landlordName: string }): string;

  // Errors
  errorGeneric(): string;
  errorInvalidInput(): string;
  errorInvalidOtp(args: { attemptsLeft: number }): string;
  errorOtpExpired(): string;
  errorOtpResent(): string;
  errorAlreadyRegistered(): string;
  errorInvalidPropertyCode(): string;
  errorPropertyFull(): string;
  errorOtpRateLimited(): string;
  errorTooManyOtpAttempts(): string;
  errorBackendUnavailable(): string;
  errorAuthExpired(): string;

  // BUY flow
  buyAmountPrompt(): string;
  buyConfirm(args: { amountNgn: number; expectedGrd: number }): string;
  paymentInstructionsBank(args: {
    amountNgn: number;
    accountNumber: string;
    accountName: string;
    bankName: string;
    txRef: string;
    expiresAtIso: string;
  }): string;
  paymentInstructionsMobileMoney(args: {
    amountNgn: number;
    ussdCode: string;
    provider: string;
    txRef: string;
    expiresAtIso: string;
  }): string;
  awaitingPayment(): string;
  errorInvalidAmount(args: { min: number; max: number }): string;
  errorInsufficientBalance(): string;
  errorPaymentInitiationFailed(): string;

  // Commands — generic + per-role
  helpTenant(): string;
  helpLandlord(): string;
  helpUnauthenticated(): string;
  balanceView(args: {
    balanceGrd: number;
    estimatedDaysRemaining: number;
    status: 'CONNECTED' | 'CUTOFF';
  }): string;
  historyEmpty(): string;
  historyView(args: {
    entries: ReadonlyArray<{
      kind: 'TOPUP' | 'CONSUMPTION' | 'REFUND';
      amountGrd: number;
      amountNgn: number | null;
      balanceAfterGrd: number;
      at: string;
    }>;
  }): string;
  myPropertiesEmpty(): string;
  myPropertiesView(args: {
    properties: ReadonlyArray<{
      propertyCode: string;
      label: string;
      flatCount: number;
      occupiedCount: number;
      pendingEarningsGrd: number;
    }>;
  }): string;
  earningsView(args: {
    pendingNgn: number;
    totalEarnedNgn: number;
  }): string;
  unrecognizedCommand(): string;
  menuReturnTenant(): string;
  menuReturnLandlord(): string;
  menuReturnUnauthenticated(): string;
}

/**
 * Default English implementation. Mark's production templates will replace
 * this, but the interface contract stays the same.
 */
export class DefaultTemplates implements ITemplates {
  rolePrompt(): string {
    return 'Welcome to Gridee ⚡\n\nAre you a:\n(1) Landlord\n(2) Tenant\n\nReply with 1 or 2.';
  }

  landlordRegName(): string {
    return 'Great! What is your full name?';
  }

  landlordRegPhone(): string {
    return 'Enter your phone number for verification (e.g. +2348031234567):';
  }

  landlordRegOtp(): string {
    return 'A 6-digit code has been sent to your phone. Enter it to continue.\n\n(Type RESEND to get a new code.)';
  }

  tenantRegName(): string {
    return 'Welcome! What is your full name?';
  }

  tenantRegPhone(): string {
    return 'Enter your phone number for verification (e.g. +2348031234567):';
  }

  tenantRegOtp(): string {
    return 'A 6-digit code has been sent to your phone. Enter it to continue.\n\n(Type RESEND to get a new code.)';
  }

  tenantRegPropCode(): string {
    return 'Enter the Property Code your landlord gave you (e.g. GRD-LAG-0042):';
  }

  addPropertyAddress(): string {
    return 'Now let\'s register your first property.\n\nEnter the property address (street, area, state):';
  }

  addPropertyFlatCount(): string {
    return 'How many rentable flats/units are in this compound? (1–1000)';
  }

  addPropertyLabel(): string {
    return 'Give this property a short name (e.g. "Surulere Block A"):';
  }

  propertyRegistered({ propertyCode, label }: { propertyCode: string; label: string }): string {
    return (
      `✅ Property registered!\n\n` +
      `Name: ${label}\n` +
      `Code: ${propertyCode}\n\n` +
      `Share this code with your tenants so they can sign up.\n\n` +
      `Type HELP to see what you can do next.`
    );
  }

  welcomeAuthenticated({ fullName, role }: { fullName: string; role: 'landlord' | 'tenant' }): string {
    const greeting = role === 'landlord' ? 'Welcome, landlord' : 'Welcome';
    return `${greeting} ${fullName}! ✅`;
  }

  tenantOnboardingComplete({
    propertyLabel,
    landlordName,
  }: {
    propertyLabel: string;
    landlordName: string;
  }): string {
    return (
      `✅ You're all set!\n\n` +
      `You're now linked to ${propertyLabel} (landlord: ${landlordName}).\n\n` +
      `Type BUY <amount> to top up your meter, or HELP to see all options.`
    );
  }

  errorGeneric(): string {
    return 'Sorry, something went wrong. Please try again.';
  }

  errorInvalidInput(): string {
    return "I didn't understand that. Please follow the prompt.";
  }

  errorInvalidOtp({ attemptsLeft }: { attemptsLeft: number }): string {
    if (attemptsLeft <= 0) return this.errorTooManyOtpAttempts();
    return `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.\n\n(Type RESEND for a new code.)`;
  }

  errorOtpExpired(): string {
    return 'Your code has expired. Type RESEND to get a new one.';
  }

  errorOtpResent(): string {
    return 'A new code has been sent. Enter it to continue.';
  }

  errorAlreadyRegistered(): string {
    return 'This phone number is already registered. Type HELP to see what you can do.';
  }

  errorInvalidPropertyCode(): string {
    return 'That property code is not recognized. Please check with your landlord and try again.\n\nFormat: GRD-XXX-NNNN';
  }

  errorPropertyFull(): string {
    return 'That property is fully occupied. Please contact your landlord.';
  }

  errorOtpRateLimited(): string {
    return 'Too many code requests. Please wait a few minutes and try again.';
  }

  errorTooManyOtpAttempts(): string {
    return 'Too many incorrect attempts. Please start over by sending any message.';
  }

  errorBackendUnavailable(): string {
    return "Our system is temporarily unavailable. Please try again in a moment.";
  }

  errorAuthExpired(): string {
    return 'Your session has expired. Please start over by sending any message.';
  }

  // ── BUY flow ────────────────────────────────────────────────────────────

  buyAmountPrompt(): string {
    return 'How much would you like to spend? Reply with the amount in Naira (e.g. 2000).';
  }

  buyConfirm({ amountNgn, expectedGrd }: { amountNgn: number; expectedGrd: number }): string {
    return (
      `You're about to buy ${expectedGrd.toFixed(2)} GRD for ₦${amountNgn.toLocaleString('en-NG')}.\n\n` +
      `Choose a payment method:\n` +
      `(1) Bank transfer\n` +
      `(2) Mobile money\n\n` +
      `Reply with 1 or 2.`
    );
  }

  paymentInstructionsBank({
    amountNgn,
    accountNumber,
    accountName,
    bankName,
    txRef,
    expiresAtIso,
  }: {
    amountNgn: number;
    accountNumber: string;
    accountName: string;
    bankName: string;
    txRef: string;
    expiresAtIso: string;
  }): string {
    const expiresLocal = formatTimeShort(expiresAtIso);
    return (
      `Transfer ₦${amountNgn.toLocaleString('en-NG')} to:\n\n` +
      `Bank: ${bankName}\n` +
      `Account: ${accountNumber}\n` +
      `Name: ${accountName}\n\n` +
      `Reference: ${txRef}\n` +
      `Expires: ${expiresLocal}\n\n` +
      `You'll get a confirmation here once payment lands. (Usually under 60 seconds.)`
    );
  }

  paymentInstructionsMobileMoney({
    amountNgn,
    ussdCode,
    provider,
    txRef,
    expiresAtIso,
  }: {
    amountNgn: number;
    ussdCode: string;
    provider: string;
    txRef: string;
    expiresAtIso: string;
  }): string {
    const expiresLocal = formatTimeShort(expiresAtIso);
    return (
      `Pay ₦${amountNgn.toLocaleString('en-NG')} via ${provider}.\n\n` +
      `Dial: ${ussdCode}\n` +
      `Reference: ${txRef}\n` +
      `Expires: ${expiresLocal}\n\n` +
      `You'll get a confirmation here once payment lands.`
    );
  }

  awaitingPayment(): string {
    return 'Waiting for your payment to land. You\'ll get a confirmation here as soon as it does.';
  }

  errorInvalidAmount({ min, max }: { min: number; max: number }): string {
    return `Enter an amount between ₦${min.toLocaleString('en-NG')} and ₦${max.toLocaleString('en-NG')}.`;
  }

  errorInsufficientBalance(): string {
    return 'Insufficient balance for this operation.';
  }

  errorPaymentInitiationFailed(): string {
    return "We couldn't start that payment. Please try again in a moment.";
  }

  // ── Commands ────────────────────────────────────────────────────────────

  helpTenant(): string {
    return (
      `Available commands:\n\n` +
      `BUY <amount> — top up your meter (e.g. BUY 5000)\n` +
      `BALANCE — check your remaining GRD\n` +
      `HISTORY — see recent transactions\n` +
      `MENU — return to the main menu\n` +
      `HELP — show this menu`
    );
  }

  helpLandlord(): string {
    return (
      `Available commands:\n\n` +
      `MY_PROPERTIES — list your properties\n` +
      `EARNINGS — view pending earnings\n` +
      `WITHDRAW <amount> — withdraw funds (e.g. WITHDRAW 50000)\n` +
      `MENU — return to the main menu\n` +
      `HELP — show this menu`
    );
  }

  helpUnauthenticated(): string {
    return 'You need to register first. Send any message to get started.';
  }

  balanceView({
    balanceGrd,
    estimatedDaysRemaining,
    status,
  }: {
    balanceGrd: number;
    estimatedDaysRemaining: number;
    status: 'CONNECTED' | 'CUTOFF';
  }): string {
    const stateEmoji = status === 'CONNECTED' ? '🟢' : '🔴';
    const days =
      estimatedDaysRemaining >= 1
        ? `~${estimatedDaysRemaining.toFixed(1)} days left`
        : `~${(estimatedDaysRemaining * 24).toFixed(0)} hours left`;
    return (
      `${stateEmoji} ${status}\n` +
      `Balance: ${balanceGrd.toFixed(2)} GRD\n` +
      `${days}\n\n` +
      `Type BUY <amount> to top up.`
    );
  }

  historyEmpty(): string {
    return 'No transactions yet. Type BUY <amount> to make your first top-up.';
  }

  historyView({
    entries,
  }: {
    entries: ReadonlyArray<{
      kind: 'TOPUP' | 'CONSUMPTION' | 'REFUND';
      amountGrd: number;
      amountNgn: number | null;
      balanceAfterGrd: number;
      at: string;
    }>;
  }): string {
    const lines = entries.slice(0, 10).map((e) => {
      const sign = e.amountGrd >= 0 ? '+' : '';
      const grd = `${sign}${e.amountGrd.toFixed(2)} GRD`;
      const ngn = e.amountNgn !== null ? ` (₦${e.amountNgn.toLocaleString('en-NG')})` : '';
      const date = formatTimeShort(e.at);
      return `${date}  ${e.kind.toLowerCase()}  ${grd}${ngn}`;
    });
    return `Recent transactions:\n\n${lines.join('\n')}`;
  }

  myPropertiesEmpty(): string {
    return "You don't have any properties yet. Send any message to register one.";
  }

  myPropertiesView({
    properties,
  }: {
    properties: ReadonlyArray<{
      propertyCode: string;
      label: string;
      flatCount: number;
      occupiedCount: number;
      pendingEarningsGrd: number;
    }>;
  }): string {
    const lines = properties.map((p) => {
      const occupancy = `${p.occupiedCount}/${p.flatCount} occupied`;
      return `${p.propertyCode}  ${p.label}\n  ${occupancy} · ${p.pendingEarningsGrd.toFixed(2)} GRD pending`;
    });
    return `Your properties:\n\n${lines.join('\n\n')}`;
  }

  earningsView({
    pendingNgn,
    totalEarnedNgn,
  }: {
    pendingNgn: number;
    totalEarnedNgn: number;
  }): string {
    return (
      `Earnings\n\n` +
      `Pending: ₦${pendingNgn.toLocaleString('en-NG')}\n` +
      `Total earned: ₦${totalEarnedNgn.toLocaleString('en-NG')}\n\n` +
      `Type WITHDRAW <amount> to cash out.`
    );
  }

  unrecognizedCommand(): string {
    return "I didn't recognize that. Type HELP to see what you can do.";
  }

  menuReturnTenant(): string {
    return 'Back to the menu. Type HELP for what you can do, or BUY <amount> to top up.';
  }

  menuReturnLandlord(): string {
    return 'Back to the menu. Type HELP for what you can do.';
  }

  menuReturnUnauthenticated(): string {
    return "Let's start over. Are you a (1) Landlord or (2) Tenant?";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp as a short local time, e.g. "10:23 AM".
 * Falls back to the raw string if Intl is unavailable.
 */
function formatTimeShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}
