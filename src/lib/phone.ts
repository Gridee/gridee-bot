import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Phone — branded E.164 string
//
// Lives in lib/ (not session/) because messaging, notifications, and many
// other modules need it. session/types.ts re-exports it for back-compat.
// ─────────────────────────────────────────────────────────────────────────────

declare const phoneBrand: unique symbol;
export type Phone = string & { readonly [phoneBrand]: true };

/**
 * E.164 phone number, with leading +.
 * Source: https://www.itu.int/rec/T-REC-E.164/
 * Pattern: +[1-9][0-9]{6,14}  (1 to 15 total digits, no leading zero on country code)
 *
 * Normalize OUTSIDE the schema — accept whatever string the caller gives,
 * brand it once it's verified to match the format.
 */
const PhoneSchema = z
  .string()
  .regex(/^\+[1-9][0-9]{6,14}$/, 'Phone must be E.164 format, e.g. +2348031234567')
  .transform((v): Phone => v as Phone);

export const Phone = {
  schema: PhoneSchema,
  /** Throws if invalid. */
  of(raw: string): Phone {
    return PhoneSchema.parse(raw);
  },
  /** Returns null if invalid. Use when input is untrusted. */
  tryOf(raw: string): Phone | null {
    const result = PhoneSchema.safeParse(raw);
    return result.success ? result.data : null;
  },
};
