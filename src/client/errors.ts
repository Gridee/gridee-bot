import { GrideeError } from '../lib/errors';
import type { BackendErrorCode } from './contracts';

/**
 * Base class for all errors thrown / returned by BackendClient.
 *
 * The client returns errors through Result<T, BackendError> rather than
 * throwing, so callers (flows, dispatchers) can pattern-match on error class
 * without try/catch noise. Methods that hit transport-level failures use
 * BackendNetworkError; protocol-level failures use BackendApiError; schema
 * drift uses BackendContractError.
 */
export class BackendError extends GrideeError {}

/**
 * The backend returned a structured 4xx/5xx error envelope.
 * The `code` field maps to a SCREENS.md template via the dispatcher.
 */
export class BackendApiError extends BackendError {
  constructor(
    message: string,
    public readonly code: BackendErrorCode | string,
    public readonly httpStatus: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Authentication failed — JWT expired, missing, or invalid. Caller should clear the session JWT. */
export class BackendAuthError extends BackendApiError {}

/** Network error, timeout, or DNS failure. Caller may retry. */
export class BackendNetworkError extends BackendError {}

/**
 * Response shape did not match the expected Zod schema.
 * Indicates a contract drift between bot and backend — should be a noisy
 * alarm in observability, not a routine retry.
 */
export class BackendContractError extends BackendError {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly issues: ReadonlyArray<string>,
  ) {
    super(message);
  }
}

/**
 * Result<T, E> — explicit success/failure without throwing.
 *
 * Idiomatic usage:
 *   const result = await client.registerLandlord({...});
 *   if (!result.ok) {
 *     // handle result.error
 *     return;
 *   }
 *   const data = result.value;  // typed as RegisterLandlordResponse
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });
