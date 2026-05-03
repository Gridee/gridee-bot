/**
 * Base error class for all Gridee bot errors.
 * All errors thrown by our code should extend this — never throw bare `Error`.
 * This lets the top-level dispatcher distinguish our errors from unexpected ones.
 */
export class GrideeError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    // Preserve stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Configuration / env loading failure. Should crash the process at boot. */
export class ConfigError extends GrideeError {}

/** Session store error — connection, serialization, validation. */
export class SessionStoreError extends GrideeError {}

/** Lock could not be acquired within the configured timeout. Typically transient. */
export class LockTimeoutError extends SessionStoreError {}

/** Stored session data failed schema validation. The store self-heals by deleting it. */
export class SessionCorruptError extends SessionStoreError {}
