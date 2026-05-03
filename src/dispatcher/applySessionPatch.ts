import type { SessionPatch } from '../flows';
import type { SessionState } from '../session/types';

/**
 * Apply a patch returned by a flow handler to the current session state.
 *
 * Field rules:
 *   - step / role / userId: replaced if present in patch
 *   - jwt: replaced if present; cleared if `jwtClear` is true
 *   - data: shallow-merged by default; if `clearData` is true, REPLACED
 *           (then patch.data is the new full data, if any)
 *   - createdAt: never touched
 *   - updatedAt: ALWAYS bumped to now (the store will re-bump too — that's fine)
 */
export function applySessionPatch(session: SessionState, patch: SessionPatch): SessionState {
  // Start from a shallow copy so we don't mutate input
  const next: SessionState = {
    step: session.step,
    role: session.role,
    data: { ...session.data },
    createdAt: session.createdAt,
    updatedAt: Date.now(),
  };
  if (session.jwt !== undefined) next.jwt = session.jwt;
  if (session.userId !== undefined) next.userId = session.userId;

  // Apply patch
  if (patch.step !== undefined) next.step = patch.step;
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.userId !== undefined) next.userId = patch.userId;

  if (patch.jwtClear) {
    delete next.jwt;
  } else if (patch.jwt !== undefined) {
    next.jwt = patch.jwt;
  }

  if (patch.clearData) {
    // clearData wins: replace, optionally with new fields
    next.data = { ...(patch.data ?? {}) };
  } else if (patch.data !== undefined) {
    // Default: shallow merge
    next.data = { ...next.data, ...patch.data };
  }

  return next;
}
