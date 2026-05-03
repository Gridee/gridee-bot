/**
 * Bot ⇄ Backend HTTP contracts.
 *
 * THIS FILE IS THE SOURCE OF TRUTH for every request and response shape
 * exchanged between the bot and the backend. It MUST be kept identical in
 * both repos:
 *   - gridee-bot/src/client/contracts.ts       (THIS FILE — used to build requests, validate responses)
 *   - gridee-backend/src/contracts/index.ts    (DUPLICATE — used to validate requests, build responses)
 *
 * Any change here = a change in the duplicate file in the other repo.
 *
 * All schemas use Zod so that:
 *   1. Types are auto-derived (no hand-written interfaces drifting from schemas)
 *   2. Runtime validation catches drift immediately with a precise error
 *   3. Both sides validate the same way — bot validates response, backend
 *      validates request, both using the same schema.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

/** E.164 phone, with leading +. */
export const PhoneSchema = z
  .string()
  .regex(/^\+[1-9][0-9]{6,14}$/, 'Phone must be E.164 format');

/** 6-digit OTP. */
export const OtpSchema = z.string().regex(/^[0-9]{6}$/, 'OTP must be 6 digits');

/** Property code, e.g. "GRD-LAG-0042". Pattern: GRD-[A-Z]{3}-[0-9]{4}. */
export const PropertyCodeSchema = z
  .string()
  .regex(/^GRD-[A-Z]{3}-[0-9]{4}$/, 'Property code format: GRD-XXX-NNNN');

/** ISO 8601 timestamp string. */
export const IsoTimestampSchema = z.string().datetime();

export const RoleSchema = z.enum(['landlord', 'tenant']);
export type Role = z.infer<typeof RoleSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Standard error envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every non-2xx response from the backend should match this shape.
 * `code` is the machine-readable error class — the bot uses it to decide
 * which screen template to show. `message` is human-readable.
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Known error codes. The bot maps these to specific Screen IDs / templates.
 * Add new codes as endpoints grow — the dispatcher will fall back to
 * ERROR_GENERIC for unknown codes.
 */
export const BackendErrorCodes = {
  INVALID_OTP: 'INVALID_OTP',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  ALREADY_REGISTERED: 'ALREADY_REGISTERED',
  PHONE_NOT_REGISTERED: 'PHONE_NOT_REGISTERED',
  INVALID_PROPERTY_CODE: 'INVALID_PROPERTY_CODE',
  PROPERTY_FULL: 'PROPERTY_FULL',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  PAYMENT_INITIATION_FAILED: 'PAYMENT_INITIATION_FAILED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL: 'INTERNAL',
} as const;
export type BackendErrorCode = typeof BackendErrorCodes[keyof typeof BackendErrorCodes];

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/landlord/register — start landlord registration (sends OTP)
export const RegisterLandlordRequestSchema = z.object({
  fullName: z.string().min(2).max(100),
  phone: PhoneSchema,
});
export const RegisterLandlordResponseSchema = z.object({
  /** Server-issued reference for this OTP session. Used in /verify. */
  otpRef: z.string().min(1),
  expiresAt: IsoTimestampSchema,
});
export type RegisterLandlordRequest = z.infer<typeof RegisterLandlordRequestSchema>;
export type RegisterLandlordResponse = z.infer<typeof RegisterLandlordResponseSchema>;

// POST /api/auth/tenant/register — start tenant registration (sends OTP)
// Property code is collected AFTER OTP verification per SCREENS.md.
export const RegisterTenantRequestSchema = z.object({
  fullName: z.string().min(2).max(100),
  phone: PhoneSchema,
});
export const RegisterTenantResponseSchema = z.object({
  otpRef: z.string().min(1),
  expiresAt: IsoTimestampSchema,
});
export type RegisterTenantRequest = z.infer<typeof RegisterTenantRequestSchema>;
export type RegisterTenantResponse = z.infer<typeof RegisterTenantResponseSchema>;

// POST /api/auth/verify — verify OTP, get JWT
export const VerifyOtpRequestSchema = z.object({
  otpRef: z.string().min(1),
  otp: OtpSchema,
});
export const VerifyOtpResponseSchema = z.object({
  jwt: z.string().min(1),
  userId: z.string().min(1),
  role: RoleSchema,
  /** When the JWT expires (server-authoritative). */
  expiresAt: IsoTimestampSchema,
});
export type VerifyOtpRequest = z.infer<typeof VerifyOtpRequestSchema>;
export type VerifyOtpResponse = z.infer<typeof VerifyOtpResponseSchema>;

// POST /api/auth/resend — resend OTP for an existing otpRef
export const ResendOtpRequestSchema = z.object({
  otpRef: z.string().min(1),
});
export const ResendOtpResponseSchema = z.object({
  expiresAt: IsoTimestampSchema,
});
export type ResendOtpRequest = z.infer<typeof ResendOtpRequestSchema>;
export type ResendOtpResponse = z.infer<typeof ResendOtpResponseSchema>;

// POST /api/auth/tenant/link-property — after OTP verify, attach property code
export const LinkPropertyRequestSchema = z.object({
  propertyCode: PropertyCodeSchema,
});
export const LinkPropertyResponseSchema = z.object({
  propertyId: z.string().min(1),
  propertyLabel: z.string(),
  landlordName: z.string(),
});
export type LinkPropertyRequest = z.infer<typeof LinkPropertyRequestSchema>;
export type LinkPropertyResponse = z.infer<typeof LinkPropertyResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// LANDLORD — properties
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/landlords/me/properties — register a new property
export const AddPropertyRequestSchema = z.object({
  address: z.string().min(5).max(500),
  flatCount: z.number().int().min(1).max(1000),
  label: z.string().min(2).max(100),
});
export const AddPropertyResponseSchema = z.object({
  propertyId: z.string().min(1),
  propertyCode: PropertyCodeSchema,
  label: z.string(),
});
export type AddPropertyRequest = z.infer<typeof AddPropertyRequestSchema>;
export type AddPropertyResponse = z.infer<typeof AddPropertyResponseSchema>;

// GET /api/landlords/me/properties
export const PropertySummarySchema = z.object({
  propertyId: z.string().min(1),
  propertyCode: PropertyCodeSchema,
  label: z.string(),
  address: z.string(),
  flatCount: z.number().int(),
  occupiedCount: z.number().int(),
  pendingEarningsGrd: z.number().nonnegative(),
});
export const ListPropertiesResponseSchema = z.object({
  properties: z.array(PropertySummarySchema),
});
export type PropertySummary = z.infer<typeof PropertySummarySchema>;
export type ListPropertiesResponse = z.infer<typeof ListPropertiesResponseSchema>;

// GET /api/landlords/me/properties/:propertyId/tenants
export const TenantSummarySchema = z.object({
  tenantId: z.string().min(1),
  fullName: z.string(),
  phone: PhoneSchema,
  balanceGrd: z.number().nonnegative(),
  status: z.enum(['CONNECTED', 'CUTOFF']),
  joinedAt: IsoTimestampSchema,
});
export const ListTenantsResponseSchema = z.object({
  tenants: z.array(TenantSummarySchema),
});
export type TenantSummary = z.infer<typeof TenantSummarySchema>;
export type ListTenantsResponse = z.infer<typeof ListTenantsResponseSchema>;

// POST /api/landlords/me/tenants/remove
export const RemoveTenantRequestSchema = z.object({
  tenantPhone: PhoneSchema,
});
export const RemoveTenantResponseSchema = z.object({
  tenantId: z.string().min(1),
  refundedGrd: z.number().nonnegative(),
});
export type RemoveTenantRequest = z.infer<typeof RemoveTenantRequestSchema>;
export type RemoveTenantResponse = z.infer<typeof RemoveTenantResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// LANDLORD — earnings & withdrawal
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/landlords/me/earnings
export const EarningsResponseSchema = z.object({
  pendingNgn: z.number().nonnegative(),
  totalEarnedNgn: z.number().nonnegative(),
  byProperty: z.array(
    z.object({
      propertyId: z.string().min(1),
      propertyCode: PropertyCodeSchema,
      pendingNgn: z.number().nonnegative(),
      totalEarnedNgn: z.number().nonnegative(),
    }),
  ),
});
export type EarningsResponse = z.infer<typeof EarningsResponseSchema>;

// POST /api/landlords/me/withdraw
export const WithdrawRequestSchema = z.object({
  amountNgn: z.number().positive(),
  bankAccountNumber: z.string().regex(/^[0-9]{10}$/, 'Account must be 10 digits'),
  bankCode: z.string().regex(/^[0-9]{3}$/, 'Bank code must be 3 digits'),
});
export const WithdrawResponseSchema = z.object({
  withdrawalId: z.string().min(1),
  amountNgn: z.number().positive(),
  estimatedArrival: IsoTimestampSchema,
});
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;
export type WithdrawResponse = z.infer<typeof WithdrawResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// TENANT — balance, history, payments
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/tenants/me/balance
export const BalanceResponseSchema = z.object({
  balanceGrd: z.number().nonnegative(),
  estimatedDaysRemaining: z.number().nonnegative(),
  status: z.enum(['CONNECTED', 'CUTOFF']),
  lastUpdatedAt: IsoTimestampSchema,
});
export type BalanceResponse = z.infer<typeof BalanceResponseSchema>;

// GET /api/tenants/me/history?limit=20
export const TransactionEntrySchema = z.object({
  txId: z.string().min(1),
  kind: z.enum(['TOPUP', 'CONSUMPTION', 'REFUND']),
  amountGrd: z.number(), // negative for consumption
  amountNgn: z.number().nullable(), // null for consumption
  balanceAfterGrd: z.number().nonnegative(),
  at: IsoTimestampSchema,
});
export const HistoryResponseSchema = z.object({
  transactions: z.array(TransactionEntrySchema),
});
export type TransactionEntry = z.infer<typeof TransactionEntrySchema>;
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

// POST /api/payments/initiate
export const InitiatePaymentRequestSchema = z.object({
  amountNgn: z.number().positive().max(1_000_000),
  method: z.enum(['BANK_TRANSFER', 'MOBILE_MONEY']),
});
export const InitiatePaymentResponseSchema = z.object({
  paymentId: z.string().min(1),
  txRef: z.string().min(1),
  /** Bank transfer details — present iff method=BANK_TRANSFER. */
  bankTransfer: z
    .object({
      accountNumber: z.string(),
      accountName: z.string(),
      bankName: z.string(),
    })
    .optional(),
  /** Mobile money instructions — present iff method=MOBILE_MONEY. */
  mobileMoney: z
    .object({
      ussdCode: z.string(),
      provider: z.string(),
    })
    .optional(),
  amountNgn: z.number().positive(),
  expectedGrd: z.number().positive(),
  expiresAt: IsoTimestampSchema,
});
export type InitiatePaymentRequest = z.infer<typeof InitiatePaymentRequestSchema>;
export type InitiatePaymentResponse = z.infer<typeof InitiatePaymentResponseSchema>;
