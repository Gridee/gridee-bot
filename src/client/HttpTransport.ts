import { randomUUID } from 'crypto';
import { z } from 'zod';
import { logger } from '../lib/logger';
import {
  ErrorResponseSchema,
  type BackendErrorCode,
} from './contracts';
import {
  BackendApiError,
  BackendAuthError,
  BackendContractError,
  BackendNetworkError,
  Err,
  Ok,
  type Result,
} from './errors';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HttpTransportOptions {
  baseUrl: string;
  /** Per-request timeout. Default: 10s. */
  timeoutMs?: number;
  /**
   * Max retry attempts for retryable failures (5xx and network errors).
   * Default: 2 retries (so up to 3 total attempts). 4xx is never retried.
   */
  maxRetries?: number;
  /** Base delay between retries (ms). Doubled per attempt + jitter. Default 200. */
  retryBaseDelayMs?: number;
  /** Optional fetch override for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional clock for testing retry sleeps. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path relative to baseUrl, must start with `/`. */
  path: string;
  /** JSON body to send. Will be stringified. */
  body?: unknown;
  /** Bearer JWT for authenticated endpoints. */
  jwt?: string;
  /**
   * Idempotency key. If supplied, sent as `Idempotency-Key` header.
   * Required for mutating endpoints that must not be double-applied.
   * If omitted on a POST, the transport auto-generates a UUID v4.
   */
  idempotencyKey?: string;
  /**
   * Override per-request timeout. Falls back to the transport default.
   */
  timeoutMs?: number;
}

interface TransportResponse {
  status: number;
  body: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// HttpTransport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Low-level HTTP transport.
 *
 * Responsibilities:
 *   - Build URL + headers + body
 *   - Apply per-request timeout (AbortController)
 *   - Attach idempotency key (auto-generated for POSTs if not supplied)
 *   - Retry on 5xx and network errors with exponential backoff + jitter
 *   - Parse JSON response, including standard error envelope
 *   - Translate failures to BackendError subclasses
 *
 * Does NOT validate request/response schemas — the typed BackendClient does
 * that on top, so this layer is reusable for ad-hoc calls.
 */
export class HttpTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpTransportOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl required');
    // Normalize: drop trailing slash so path concatenation is unambiguous
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 200;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? defaultSleep;
  }

  /**
   * Execute a request. Returns Result instead of throwing.
   *
   * On success: { ok: true, value: { status, body } }
   * On failure: { ok: false, error: BackendError }
   */
  async request(opts: RequestOptions): Promise<Result<TransportResponse, BackendNetworkError | BackendApiError>> {
    if (!opts.path.startsWith('/')) {
      return Err(new BackendNetworkError(`path must start with '/': ${opts.path}`));
    }

    const url = `${this.baseUrl}${opts.path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.jwt) headers['Authorization'] = `Bearer ${opts.jwt}`;

    // Idempotency: required for POST/PATCH/DELETE that may retry. Auto-gen if absent.
    if (opts.method !== 'GET') {
      headers['Idempotency-Key'] = opts.idempotencyKey ?? randomUUID();
    }

    const requestBody = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const requestTimeoutMs = opts.timeoutMs ?? this.timeoutMs;

    let lastError: BackendNetworkError | BackendApiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const result = await this.attempt(url, opts.method, headers, requestBody, requestTimeoutMs);

      if (result.ok) {
        const { status, body } = result.value;

        // 2xx — success, return body
        if (status >= 200 && status < 300) return Ok({ status, body });

        // 4xx — protocol error, do NOT retry. Parse error envelope.
        if (status >= 400 && status < 500) {
          return Err(toApiError(status, body));
        }

        // 5xx — server error, retryable
        lastError = toApiError(status, body);
        // Fall through to retry block
      } else {
        // Network / timeout — retryable
        lastError = result.error;
      }

      // Don't sleep after the final attempt
      if (attempt < this.maxRetries) {
        const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * this.retryBaseDelayMs;
        await this.sleep(delay + jitter);
        logger.debug({ attempt: attempt + 1, url, status: 'retry' }, 'HttpTransport retrying');
      }
    }

    // Out of retries
    return Err(lastError ?? new BackendNetworkError('Unknown transport failure'));
  }

  /**
   * Single attempt — fetch + parse. Returns transport-level errors as Result.
   */
  private async attempt(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<Result<TransportResponse, BackendNetworkError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Don't keep node alive just for this timer
    if (typeof timer.unref === 'function') timer.unref();

    let response: Response;
    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = body;
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const e = err as Error;
      const isAbort = e.name === 'AbortError';
      return Err(
        new BackendNetworkError(
          isAbort ? `Request to ${url} timed out after ${timeoutMs}ms` : `Network error: ${e.message}`,
          err,
        ),
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    const text = await response.text().catch(() => '');
    if (text.length === 0) {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON body — the body is whatever it was (HTML error page, etc.)
        parsed = { raw: text };
      }
    }

    return Ok({ status: response.status, body: parsed });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Convert a non-2xx response into a typed BackendApiError.
 * 401 maps to BackendAuthError so callers can clear session JWT.
 */
function toApiError(status: number, body: unknown): BackendApiError {
  // Try to parse standard error envelope
  const parsed = ErrorResponseSchema.safeParse(body);

  let code: BackendErrorCode | string;
  let message: string;
  let details: Record<string, unknown> | undefined;

  if (parsed.success) {
    code = parsed.data.error.code;
    message = parsed.data.error.message;
    details = parsed.data.error.details;
  } else {
    // Backend didn't return our envelope — synthesize one
    code = status === 401 ? 'UNAUTHORIZED' : status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED';
    message = `Backend returned ${status} without a recognized error envelope`;
    details = { rawBody: body };
  }

  if (status === 401) {
    return new BackendAuthError(message, code, status, details);
  }
  return new BackendApiError(message, code, status, details);
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema validation helper — used by the typed BackendClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a parsed response body against a Zod schema.
 * Returns Ok with the typed value, or Err with a BackendContractError naming
 * the offending fields. Used by every typed client method.
 */
export function validateResponse<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  endpoint: string,
): Result<z.infer<T>, BackendContractError> {
  const result = schema.safeParse(body);
  if (result.success) return Ok(result.data);
  const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  return Err(
    new BackendContractError(
      `Response from ${endpoint} did not match the expected schema`,
      endpoint,
      issues,
    ),
  );
}

/**
 * Validate a request body against a Zod schema BEFORE sending.
 * Catches bot-side bugs early (e.g. dispatcher building a malformed payload).
 */
export function validateRequest<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  endpoint: string,
): Result<z.infer<T>, BackendContractError> {
  const result = schema.safeParse(body);
  if (result.success) return Ok(result.data);
  const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  return Err(
    new BackendContractError(
      `Request to ${endpoint} failed validation before sending`,
      endpoint,
      issues,
    ),
  );
}
