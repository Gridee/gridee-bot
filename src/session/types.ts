import { z } from 'zod';

// Phone moved to lib/phone.ts — re-exported here for backward compatibility.
export { Phone, type Phone as PhoneType } from '../lib/phone';

// ─────────────────────────────────────────────────────────────────────────────
// Screen IDs — full set from SCREENS.md
// Used for: notification dispatch, template lookup, error references.
// Single source of truth — keep in sync with SCREENS.md.
// ─────────────────────────────────────────────────────────────────────────────

export const SCREEN_IDS = [
  // Shared
  'WELCOME_ROLE_SELECT',

  // Landlord registration
  'LANDLORD_REG_NAME',
  'LANDLORD_REG_PHONE',
  'LANDLORD_REG_OTP',
  'LANDLORD_AUTHENTICATED',

  // Tenant registration
  'TENANT_REG_NAME',
  'TENANT_REG_PHONE',
  'TENANT_REG_OTP',
  'TENANT_REG_PROP_CODE',
  'TENANT_AUTHENTICATED',

  // Help
  'HELP_LANDLORD',
  'HELP_TENANT',

  // Errors & system
  'ERROR_GENERIC',
  'ERROR_INVALID_OTP',
  'ERROR_OTP_EXPIRED',
  'ERROR_RESEND_OTP',
  'ERROR_ALREADY_REGISTERED',
  'ERROR_INVALID_PROP_CODE',
  'SESSION_EXPIRED',

  // BUY flow
  'BUY_AMOUNT',
  'BUY_CONFIRM',
  'PAYMENT_INSTRUCTIONS_BANK',
  'PAYMENT_INSTRUCTIONS_MOBILE_MONEY',
  'PAYMENT_INSTRUCTIONS_CRYPTO',
  'AWAITING_PAYMENT',
  'PAYMENT_CONFIRMED',
  'PAYMENT_EXPIRED',
  'PAYMENT_FAILED',

  // Tenant commands
  'BALANCE_VIEW',
  'HISTORY_VIEW',
  'MY_PROPERTY_VIEW',

  // Landlord — property management
  'MY_PROPERTIES_LIST',
  'ADD_PROPERTY_ADDRESS',
  'ADD_PROPERTY_FLAT_COUNT',
  'ADD_PROPERTY_LABEL',
  'PROPERTY_REGISTERED',
  'PROPERTY_DETAIL',
  'TENANTS_LIST',

  // Landlord — earnings & withdrawal
  'EARNINGS_OVERVIEW',
  'EARNINGS_PROPERTY',
  'WITHDRAW_BANK_INPUT',
  'WITHDRAW_CONFIRM',
  'WITHDRAWAL_INITIATED',

  // Landlord — tenant management
  'REMOVE_TENANT_PHONE',
  'REMOVE_TENANT_CONFIRM',
  'TENANT_REMOVED_LANDLORD',

  // Push notifications (system-initiated, never a session step)
  'ALERT_LOW_BALANCE',
  'ALERT_CUTOFF',
  'ALERT_RESTORED',
  'NOTIFY_NEW_TENANT',
  'NOTIFY_PURCHASE_CONFIRMED',
  'NOTIFY_WITHDRAWAL_CONFIRMED',
  'NOTIFY_TENANT_REMOVED',
  'TENANT_REMOVED_EVICTED',

  // Template-only (used by templates module, not as session steps)
  'OTP_SENT',
  'OTP_INVALID',
  'OTP_RESENT',
  'ROLE_PROMPT',
  'REGISTRATION_SUCCESS',
  'ALREADY_REGISTERED',
  'PURCHASE_SMS_CONFIRMATION',
] as const;

export const ScreenIdSchema = z.enum(SCREEN_IDS);
export type ScreenId = z.infer<typeof ScreenIdSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// SessionStep — subset of ScreenIds that may appear as `session.step`
// Push/notification/template-only screens are NOT valid session states.
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_STEPS = [
  // Shared
  'WELCOME_ROLE_SELECT',

  // Landlord onboarding (chained: REG → AUTH → ADD_PROPERTY)
  'LANDLORD_REG_NAME',
  'LANDLORD_REG_PHONE',
  'LANDLORD_REG_OTP',
  'LANDLORD_AUTHENTICATED',
  'ADD_PROPERTY_ADDRESS',
  'ADD_PROPERTY_FLAT_COUNT',
  'ADD_PROPERTY_LABEL',

  // Tenant onboarding
  'TENANT_REG_NAME',
  'TENANT_REG_PHONE',
  'TENANT_REG_OTP',
  'TENANT_REG_PROP_CODE',
  'TENANT_AUTHENTICATED',

  // Active flows
  'BUY_AMOUNT',
  'BUY_CONFIRM',
  'AWAITING_PAYMENT',
  'WITHDRAW_BANK_INPUT',
  'WITHDRAW_CONFIRM',
  'REMOVE_TENANT_PHONE',
  'REMOVE_TENANT_CONFIRM',
] as const;

export const SessionStepSchema = z.enum(SESSION_STEPS);
export type SessionStep = z.infer<typeof SessionStepSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Role
// ─────────────────────────────────────────────────────────────────────────────

export const RoleSchema = z.enum(['landlord', 'tenant']);
export type Role = z.infer<typeof RoleSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// SessionState — what we persist per phone
// ─────────────────────────────────────────────────────────────────────────────

export const SessionStateSchema = z.object({
  step: SessionStepSchema,
  role: RoleSchema.nullable(),
  data: z.record(z.string(), z.unknown()),
  jwt: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * Build a fresh session state. Both timestamps are set to now.
 * Use this in the dispatcher when initializing a session for an unknown phone.
 */
export function newSessionState(input: {
  step: SessionStep;
  role?: Role | null;
  data?: Record<string, unknown>;
  jwt?: string;
  userId?: string;
}): SessionState {
  const now = Date.now();
  // Build object conditionally so `exactOptionalPropertyTypes` is happy
  const base: SessionState = {
    step: input.step,
    role: input.role ?? null,
    data: input.data ?? {},
    createdAt: now,
    updatedAt: now,
  };
  if (input.jwt !== undefined) base.jwt = input.jwt;
  if (input.userId !== undefined) base.userId = input.userId;
  return base;
}
