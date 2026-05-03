import { z } from 'zod';
import {
  BackendApiError,
  BackendAuthError,
  BackendContractError,
  BackendError,
  BackendErrorCodes,
  BackendNetworkError,
  type Result,
} from '../client';
import type { ITemplates } from '../templates';
import type { FlowResult, SessionPatch } from './IFlow';

/**
 * Parse a 6-digit OTP. Returns null if not a 6-digit numeric string.
 * Strips whitespace; rejects anything else.
 */
export function parseOtp(input: string): string | null {
  const trimmed = input.trim();
  return /^[0-9]{6}$/.test(trimmed) ? trimmed : null;
}

/**
 * Parse a property code, normalizing to upper-case.
 * Returns null if doesn't match GRD-XXX-NNNN format.
 */
export function parsePropertyCode(input: string): string | null {
  const upper = input.trim().toUpperCase();
  return /^GRD-[A-Z]{3}-[0-9]{4}$/.test(upper) ? upper : null;
}

/** Strict integer parse — rejects "3 flats", "3.5", etc. */
export function parseStrictPositiveInt(input: string, max = 1000): number | null {
  const trimmed = input.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/**
 * Validate a free-text input length (e.g. address, label).
 * Returns null if outside bounds.
 */
export function parseTextLength(input: string, min: number, max: number): string | null {
  const trimmed = input.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

/** Phone number from user input. Strips spaces, accepts E.164. */
export function parsePhoneInput(input: string): string | null {
  const cleaned = input.trim().replace(/\s+/g, '');
  return /^\+[1-9][0-9]{6,14}$/.test(cleaned) ? cleaned : null;
}

/**
 * Parse a free-text full name. Allows letters, spaces, hyphens, apostrophes.
 * Min 2 chars, max 100. Rejects digits.
 */
export function parseFullName(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return null;
  if (!/^[\p{L}][\p{L}\s'\-.]*$/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * Recognize "RESEND" as a case-insensitive command keyword.
 */
export function isResendKeyword(input: string): boolean {
  return input.trim().toUpperCase() === 'RESEND';
}

/**
 * Recognize role selection — returns 'landlord' | 'tenant' | null.
 * Accepts: "1", "2", "LANDLORD", "TENANT" (case-insensitive).
 */
export function parseRoleSelection(input: string): 'landlord' | 'tenant' | null {
  const v = input.trim().toUpperCase();
  if (v === '1' || v === 'LANDLORD') return 'landlord';
  if (v === '2' || v === 'TENANT') return 'tenant';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping — convert BackendError to a FlowStay with a user-visible reply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a BackendError to a user-visible FlowResult.
 *
 * Special cases:
 *   - 401 / BackendAuthError → FlowReset (session unrecoverable)
 *   - Specific BackendErrorCodes → specific templates
 *   - Everything else → generic "try again" stay
 */
export function backendErrorToFlowResult(
  error: BackendError,
  templates: ITemplates,
  log?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
): FlowResult {
  if (error instanceof BackendAuthError) {
    log?.warn({ code: error.code }, 'Backend auth error — resetting session');
    return { kind: 'reset', reply: templates.errorAuthExpired() };
  }

  if (error instanceof BackendNetworkError) {
    log?.warn({ msg: error.message }, 'Backend network error');
    return { kind: 'stay', reply: templates.errorBackendUnavailable() };
  }

  if (error instanceof BackendContractError) {
    // This is a programmer-visible error, not a user-fixable one. Log loudly.
    log?.error({ endpoint: error.endpoint, issues: error.issues }, 'Backend contract drift');
    return { kind: 'stay', reply: templates.errorGeneric() };
  }

  if (error instanceof BackendApiError) {
    switch (error.code) {
      case BackendErrorCodes.INVALID_OTP: {
        const attemptsLeft = readNumber(error.details, 'attemptsLeft') ?? 0;
        return { kind: 'stay', reply: templates.errorInvalidOtp({ attemptsLeft }) };
      }
      case BackendErrorCodes.OTP_EXPIRED:
        return { kind: 'stay', reply: templates.errorOtpExpired() };
      case BackendErrorCodes.OTP_RATE_LIMITED:
        return { kind: 'stay', reply: templates.errorOtpRateLimited() };
      case BackendErrorCodes.ALREADY_REGISTERED:
        return { kind: 'reset', reply: templates.errorAlreadyRegistered() };
      case BackendErrorCodes.INVALID_PROPERTY_CODE:
        return { kind: 'stay', reply: templates.errorInvalidPropertyCode() };
      case BackendErrorCodes.PROPERTY_FULL:
        return { kind: 'reset', reply: templates.errorPropertyFull() };
      default:
        log?.warn({ code: error.code, status: error.httpStatus }, 'Unhandled backend API error');
        return { kind: 'stay', reply: templates.errorGeneric() };
    }
  }

  // Unknown subclass of BackendError — defensive fallback
  log?.error({ name: error.name, message: error.message }, 'Unknown BackendError subclass');
  return { kind: 'stay', reply: templates.errorGeneric() };
}

function readNumber(obj: Record<string, unknown> | undefined, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result helpers — make flow handler code read more linearly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unwrap a Result<T, BackendError>. If ok, returns the value as-is.
 * If error, returns a FlowResult that the handler can return directly.
 *
 * Usage:
 *   const r = await client.registerLandlord(...);
 *   if (!r.ok) return backendErrorToFlowResult(r.error, ctx.templates, ctx.log);
 *   const data = r.value;
 */
export function unwrapOrFlow<T>(
  result: Result<T, BackendError>,
  templates: ITemplates,
  log?: Parameters<typeof backendErrorToFlowResult>[2],
): { ok: true; value: T } | { ok: false; flow: FlowResult } {
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, flow: backendErrorToFlowResult(result.error, templates, log) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionPatch builders — concise patch construction
// ─────────────────────────────────────────────────────────────────────────────

/** Merge several SessionPatch objects, with later ones overriding earlier ones. */
export function mergePatches(...patches: ReadonlyArray<SessionPatch>): SessionPatch {
  const out: SessionPatch = {};
  for (const p of patches) {
    if (p.step !== undefined) out.step = p.step;
    if (p.role !== undefined) out.role = p.role;
    if (p.jwt !== undefined) out.jwt = p.jwt;
    if (p.userId !== undefined) out.userId = p.userId;
    if (p.jwtClear) out.jwtClear = true;
    if (p.clearData) out.clearData = true;
    if (p.data !== undefined) out.data = { ...(out.data ?? {}), ...p.data };
  }
  return out;
}

/** Reusable schemas that flows extract from session.data. */
export const FlowDataSchemas = {
  fullName: z.string().min(2).max(100),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
  otpRef: z.string().min(1),
  otpAttempts: z.number().int().nonnegative(),
  address: z.string().min(5).max(500),
  flatCount: z.number().int().min(1).max(1000),
  label: z.string().min(2).max(100),
};
