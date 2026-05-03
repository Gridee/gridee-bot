import type { Phone } from '../lib/phone';
import type { SessionState, SessionStep } from '../session/types';
import type { BackendClient } from '../client';
import type { ITemplates } from '../templates';
import type { logger } from '../lib/logger';

// ─────────────────────────────────────────────────────────────────────────────
// FlowContext — read-only handle the flow gets from the dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowContext {
  phone: Phone;
  /** Current session state. The flow may NOT mutate this directly. */
  session: SessionState;
  /** Typed HTTP client to the backend. */
  client: BackendClient;
  /** User-facing copy. */
  templates: ITemplates;
  /** Structured logger (PII-redacted). */
  log: typeof logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowResult — what a flow returns to the dispatcher
//
// This is a discriminated union, not a free-form object, so the dispatcher's
// switch is exhaustively checked at compile time.
// ─────────────────────────────────────────────────────────────────────────────

/** Reply with a message and update the session to a new step. */
export interface FlowAdvance {
  kind: 'advance';
  reply: string;
  /** Partial session update. Merged with current session by dispatcher. */
  patch: SessionPatch;
}

/** Reply with a message but stay on the current step (e.g. invalid input). */
export interface FlowStay {
  kind: 'stay';
  reply: string;
  /** Optional patch — typically just `data` field updates (e.g. attempt counter). */
  patch?: SessionPatch;
}

/**
 * Flow is finished. The user is now in a stable authenticated state.
 * The dispatcher will route their next message to the command registry, not
 * back to a flow.
 */
export interface FlowComplete {
  kind: 'complete';
  reply: string;
  patch: SessionPatch;
}

/**
 * Reset the user back to role selection. Used after too many OTP failures,
 * after a session expiry, or when the user is in a corrupted state.
 */
export interface FlowReset {
  kind: 'reset';
  reply: string;
}

/**
 * The flow itself doesn't know what to do with this message. The dispatcher
 * may route it to a global command (HELP, RESEND, etc.) or send a generic
 * "didn't understand" reply.
 */
export interface FlowPassthrough {
  kind: 'passthrough';
}

export type FlowResult = FlowAdvance | FlowStay | FlowComplete | FlowReset | FlowPassthrough;

// ─────────────────────────────────────────────────────────────────────────────
// SessionPatch — partial update applied by dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed fields a flow can update in the session.
 * Cannot touch createdAt; updatedAt is handled by the store automatically.
 *
 * `data` is shallow-merged with existing data (use `clearData: true` to reset).
 */
export interface SessionPatch {
  step?: SessionStep;
  role?: 'landlord' | 'tenant' | null;
  /** Shallow-merged into existing session.data. */
  data?: Record<string, unknown>;
  /** If true, replaces session.data entirely instead of merging. */
  clearData?: boolean;
  jwt?: string;
  /** Pass null to explicitly remove the JWT. */
  jwtClear?: boolean;
  userId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// IFlow — every flow implements this interface
// ─────────────────────────────────────────────────────────────────────────────

export interface IFlow {
  /** Unique flow ID, e.g. 'LANDLORD_ONBOARDING'. Used in logs. */
  readonly id: string;

  /**
   * Returns true if this flow handles the given session step.
   * Used by the dispatcher to route messages to the right flow.
   */
  handles(step: SessionStep): boolean;

  /**
   * Process an incoming message. Returns a FlowResult describing what the
   * dispatcher should do next.
   *
   * MUST be synchronous-ish: any backend call should be awaited inside, but
   * the function should never schedule background work or hold open
   * resources after returning. The dispatcher serializes flow execution per
   * phone via the session lock; long-running work blocks the whole user.
   */
  handle(ctx: FlowContext, message: string): Promise<FlowResult>;
}
