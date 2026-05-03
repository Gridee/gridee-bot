import type { BackendClient } from '../client';
import type { CommandRegistry, CommandContext } from '../commands';
import type { FlowRegistry, IFlow, FlowResult, FlowContext } from '../flows';
import { GrideeError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { Phone } from '../lib/phone';
import type { IMessageSender, InboundMessage } from '../messaging';
import type { ISessionStore } from '../session/ISessionStore';
import { newSessionState, type SessionState } from '../session/types';
import type { ITemplates } from '../templates';
import { applySessionPatch } from './applySessionPatch';
import type { IInboundIdempotencyStore } from './InboundIdempotencyStore';

export interface MessageDispatcherDeps {
  sessionStore: ISessionStore;
  idempotencyStore: IInboundIdempotencyStore;
  flowRegistry: FlowRegistry;
  /**
   * Optional command registry. If omitted, no commands run; `passthrough`
   * and idle-authenticated branches send a generic "didn't recognize" nudge.
   * Tests typically pass null; production wires CommandRegistry.default().
   */
  commandRegistry?: CommandRegistry | null;
  sender: IMessageSender;
  client: BackendClient;
  templates: ITemplates;
  /**
   * Lock timeout for per-phone serialization. Should be >= the longest
   * expected backend call (default: BackendClient timeout × 1.5 + buffer).
   * Default 20s. If exceeded, the second webhook gets a polite "try again".
   */
  lockTimeoutMs?: number;
  /**
   * Lock TTL — the lock auto-expires this long after acquisition, so a
   * crashed dispatcher doesn't wedge a phone forever.
   * Default 30s.
   */
  lockTtlMs?: number;
}

/**
 * The dispatcher.
 *
 * Lifecycle of one inbound message:
 *
 *   1. Idempotency: have we seen this providerMessageId before? → 200 OK
 *   2. Acquire per-phone lock (Redis SET NX in prod; in-memory mutex in dev)
 *   3. Load session, or initialize fresh at WELCOME_ROLE_SELECT
 *   4. Pre-flow command interception:
 *        - HELP   → command handler (TBD)
 *        - RESEND → only intercepted on OTP steps; flows handle inline
 *        - BUY    → if message starts with `BUY <amount>`, seed data and
 *                   route to BUY_CONFIRM
 *   5. Find flow for current step. If found:
 *        - flow.handle() returns a FlowResult
 *        - Switch on result.kind (advance/stay/complete/reset/passthrough)
 *        - For non-passthrough: send reply FIRST, save session SECOND
 *        - For passthrough: continue to step 6
 *   6. No flow handles this step (e.g. AUTHENTICATED idle):
 *        - For now, send a friendly nudge. Commands module will replace this.
 *   7. Release lock, return.
 *
 * Errors at any stage are caught and logged. The dispatcher's caller (the
 * webhook handler) ALWAYS returns 200 to the provider.
 */
export class MessageDispatcher {
  private readonly sessionStore: ISessionStore;
  private readonly idempotencyStore: IInboundIdempotencyStore;
  private readonly flowRegistry: FlowRegistry;
  private readonly commandRegistry: CommandRegistry | null;
  private readonly sender: IMessageSender;
  private readonly client: BackendClient;
  private readonly templates: ITemplates;
  private readonly lockTimeoutMs: number;
  private readonly lockTtlMs: number;

  constructor(deps: MessageDispatcherDeps) {
    this.sessionStore = deps.sessionStore;
    this.idempotencyStore = deps.idempotencyStore;
    this.flowRegistry = deps.flowRegistry;
    this.commandRegistry = deps.commandRegistry ?? null;
    this.sender = deps.sender;
    this.client = deps.client;
    this.templates = deps.templates;
    this.lockTimeoutMs = deps.lockTimeoutMs ?? 20_000;
    this.lockTtlMs = deps.lockTtlMs ?? 30_000;
  }

  async dispatch(inbound: InboundMessage): Promise<DispatchOutcome> {
    const log = logger.child({
      provider: inbound.provider,
      messageId: inbound.providerMessageId,
    });

    // ── Step 1: idempotency ────────────────────────────────────────────────
    const idemKey = `${inbound.provider}:${inbound.providerMessageId}`;
    let isFirst: boolean;
    try {
      isFirst = await this.idempotencyStore.markProcessed(idemKey);
    } catch (err) {
      // If idempotency check fails, log and process anyway. Worse to drop a
      // user's message than to occasionally double-process.
      log.error({ err: (err as Error).message }, 'Idempotency check failed; processing anyway');
      isFirst = true;
    }
    if (!isFirst) {
      log.info('Duplicate inbound message; skipping');
      return { kind: 'duplicate' };
    }

    // ── Step 2-7: under lock ───────────────────────────────────────────────
    try {
      await this.sessionStore.withLock(
        inbound.from,
        () => this.dispatchUnderLock(inbound, log),
        { timeoutMs: this.lockTimeoutMs, ttlMs: this.lockTtlMs },
      );
      return { kind: 'handled' };
    } catch (err) {
      // Lock timeout, send failure, etc. — log and tell caller "deferred".
      // Caller always returns 200 regardless.
      log.error(
        { err: (err as Error).message, name: (err as Error).name },
        'Dispatcher failure (caller will still ACK 200)',
      );
      return { kind: 'failed', error: err as Error };
    }
  }

  // ─── Inside the lock — single-flight per phone ─────────────────────────

  private async dispatchUnderLock(inbound: InboundMessage, log: typeof logger): Promise<void> {
    // Step 3: load or initialize session
    let session = await this.sessionStore.get(inbound.from);
    let dispatcherDirty = false; // true when *we* changed session before flow ran
    if (session === null) {
      session = newSessionState({ step: 'WELCOME_ROLE_SELECT' });
      dispatcherDirty = true;
      log.info('New session initialized');
    }

    // Step 4: pre-flow command interception
    const intercepted = this.tryInterceptCommand(session, inbound.text);
    if (intercepted !== null) {
      session = applySessionPatch(session, intercepted.patch);
      dispatcherDirty = true;
      // Fall through to flow dispatch below — the patch positioned us at the
      // right step (e.g. BUY_CONFIRM with amountNgn pre-seeded).
    }

    // Step 4b: global commands that bypass flow dispatch entirely (MENU, HOME).
    // These work from ANY step, including mid-flow — useful when a user gets
    // stuck mid-onboarding or wants to escape AWAITING_PAYMENT after the
    // backend confirmed their payment out-of-band.
    if (this.commandRegistry !== null && isGlobalCommand(inbound.text)) {
      await this.runGlobalCommand(inbound, session, dispatcherDirty, log);
      return;
    }

    // Step 5: find and invoke flow
    const flow = this.flowRegistry.findForStep(session.step);
    if (flow === null) {
      // Step 6: no flow handles this step (e.g. authenticated idle).
      // Try a command. If none matches, send the generic "didn't recognize" nudge.
      await this.tryCommandOrNudge(inbound, session, dispatcherDirty, log);
      return;
    }

    const ctx: FlowContext = {
      phone: inbound.from,
      session,
      client: this.client,
      templates: this.templates,
      log,
    };

    let result: FlowResult;
    try {
      result = await flow.handle(ctx, inbound.text);
    } catch (err) {
      // A flow threw — programming bug, not user-fixable. Log loudly.
      log.error(
        { flowId: flow.id, err: (err as Error).message, stack: (err as Error).stack },
        'Flow threw — sending generic error to user',
      );
      const sent = await this.sendOrLog(inbound.from, this.templates.errorGeneric(), log);
      if (sent && dispatcherDirty) {
        await this.saveOrLog(inbound.from, session, log);
      }
      return;
    }

    await this.applyFlowResult(inbound, session, result, flow, log, dispatcherDirty);
  }

  // ─── Apply a FlowResult — send first, save second ──────────────────────

  private async applyFlowResult(
    inbound: InboundMessage,
    session: SessionState,
    result: FlowResult,
    flow: IFlow,
    log: typeof logger,
    dispatcherDirty: boolean,
  ): Promise<void> {
    const phone = inbound.from;
    switch (result.kind) {
      case 'advance':
      case 'complete': {
        const sent = await this.sendOrLog(phone, result.reply, log);
        if (!sent) {
          // Send failed — do NOT advance the session, or the user will be
          // stuck on a step they didn't see.
          log.warn({ flowId: flow.id, nextStep: result.patch.step }, 'Send failed; not advancing session');
          return;
        }
        const next = applySessionPatch(session, result.patch);
        await this.saveOrLog(phone, next, log);
        return;
      }

      case 'stay': {
        const sent = await this.sendOrLog(phone, result.reply, log);
        if (!sent) return; // no patch worth saving if reply didn't land
        if (result.patch !== undefined) {
          const next = applySessionPatch(session, result.patch);
          await this.saveOrLog(phone, next, log);
        } else if (dispatcherDirty) {
          // No patch from the flow, but dispatcher modified session before
          // flow ran (new session init, BUY shortcut, etc.). Persist that.
          await this.saveOrLog(phone, session, log);
        }
        return;
      }

      case 'reset': {
        const sent = await this.sendOrLog(phone, result.reply, log);
        // Reset regardless of send success — the user is in a bad state and
        // we want them recoverable on next message.
        if (!sent) {
          log.warn({ flowId: flow.id }, 'Reset reply send failed; clearing session anyway');
        }
        await this.clearOrLog(phone, log);
        return;
      }

      case 'passthrough': {
        // The flow declined to handle this message. Try a command; if none
        // matches, send a "didn't recognize" nudge.
        log.debug({ flowId: flow.id, step: session.step }, 'Flow passthrough — trying commands');
        await this.tryCommandOrNudge(inbound, session, dispatcherDirty, log);
        return;
      }

      default: {
        const _exhaustive: never = result;
        throw new GrideeError(`Unhandled FlowResult kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // ─── Global commands (MENU, HOME) ──────────────────────────────────────

  /**
   * Run a global command that bypasses flow dispatch. Same pattern as
   * tryCommandOrNudge but assumes the command WILL match — caller already
   * checked via isGlobalCommand().
   */
  private async runGlobalCommand(
    inbound: InboundMessage,
    session: SessionState,
    _dispatcherDirty: boolean,
    log: typeof logger,
  ): Promise<void> {
    if (this.commandRegistry === null) return; // defensive — caller should check
    const cmdCtx: CommandContext = {
      phone: inbound.from,
      session,
      client: this.client,
      templates: this.templates,
      log,
    };
    const result = await this.commandRegistry.handle(cmdCtx, inbound.text);
    if (result === null || result.kind === 'unhandled') {
      // Shouldn't happen — isGlobalCommand was true, registry should match.
      // Fall back to a generic nudge so we don't silently drop the message.
      log.warn(
        { text: inbound.text, step: session.step },
        'Global command matched isGlobalCommand but registry returned no match',
      );
      await this.sendOrLog(inbound.from, this.templates.errorInvalidInput(), log);
      return;
    }
    if (result.kind === 'reply') {
      await this.sendOrLog(inbound.from, result.text, log);
      return;
    }
    // reply+patch — send first, save second
    const sent = await this.sendOrLog(inbound.from, result.text, log);
    if (!sent) return;
    const next = applySessionPatch(session, result.patch);
    await this.saveOrLog(inbound.from, next, log);
  }

  // ─── Command lookup & idle-state nudge ─────────────────────────────────

  /**
   * Try to handle the message as a command. If a command matches:
   *   - Send the reply
   *   - Apply any patch (for reply+patch — currently unused but reserved)
   *   - Save the session if dispatcherDirty
   *
   * If no command matches:
   *   - Send a generic "didn't recognize" nudge (or `unrecognizedCommand`
   *     when role-aware copy is available)
   *   - Save the session if dispatcherDirty
   */
  private async tryCommandOrNudge(
    inbound: InboundMessage,
    session: SessionState,
    dispatcherDirty: boolean,
    log: typeof logger,
  ): Promise<void> {
    if (this.commandRegistry === null) {
      // No registry configured — generic nudge
      const sent = await this.sendOrLog(inbound.from, this.templates.errorInvalidInput(), log);
      if (sent && dispatcherDirty) await this.saveOrLog(inbound.from, session, log);
      return;
    }

    const cmdCtx: CommandContext = {
      phone: inbound.from,
      session,
      client: this.client,
      templates: this.templates,
      log,
    };

    let result;
    try {
      result = await this.commandRegistry.handle(cmdCtx, inbound.text);
    } catch (err) {
      // Defensive: ICommand contract is non-throwing, but defend anyway
      log.error(
        { err: (err as Error).message, stack: (err as Error).stack },
        'Command threw — sending generic error',
      );
      await this.sendOrLog(inbound.from, this.templates.errorGeneric(), log);
      if (dispatcherDirty) await this.saveOrLog(inbound.from, session, log);
      return;
    }

    if (result === null) {
      // No command matched — role-aware nudge
      const reply =
        session.role === 'tenant' || session.role === 'landlord'
          ? this.templates.unrecognizedCommand()
          : this.templates.errorInvalidInput();
      const sent = await this.sendOrLog(inbound.from, reply, log);
      if (sent && dispatcherDirty) await this.saveOrLog(inbound.from, session, log);
      return;
    }

    // A command matched
    if (result.kind === 'reply') {
      const sent = await this.sendOrLog(inbound.from, result.text, log);
      if (sent && dispatcherDirty) await this.saveOrLog(inbound.from, session, log);
      return;
    }

    if (result.kind === 'reply+patch') {
      // send-first save-second
      const sent = await this.sendOrLog(inbound.from, result.text, log);
      if (!sent) return;
      const next = applySessionPatch(session, result.patch);
      await this.saveOrLog(inbound.from, next, log);
      return;
    }

    // result.kind === 'unhandled' — command's matches() lied; treat as no match
    log.debug({ commandId: 'unknown' }, 'Command returned unhandled; falling back to nudge');
    const reply =
      session.role === 'tenant' || session.role === 'landlord'
        ? this.templates.unrecognizedCommand()
        : this.templates.errorInvalidInput();
    const sent = await this.sendOrLog(inbound.from, reply, log);
    if (sent && dispatcherDirty) await this.saveOrLog(inbound.from, session, log);
  }

  // ─── Pre-flow command interception ─────────────────────────────────────

  /**
   * Inspect the inbound message for global commands that should run BEFORE
   * the step's flow. Returns a SessionPatch positioning the session for the
   * follow-up flow, or null to let the normal flow handle the message.
   *
   * We deliberately keep this minimal and step-aware:
   *   - "BUY <amount>" only fires when the user is in an authenticated tenant
   *     state and not already in a flow. Otherwise the ongoing flow handles it.
   *   - "HELP" / "RESEND" are not intercepted here yet — flows handle RESEND
   *     inline; HELP comes when the commands module lands.
   */
  private tryInterceptCommand(
    session: SessionState,
    text: string,
  ): { patch: import('../flows').SessionPatch } | null {
    const upper = text.trim().toUpperCase();

    // BUY <amount> shortcut — only for authenticated tenants in idle state
    if (upper.startsWith('BUY ') && session.role === 'tenant' && session.step === 'TENANT_AUTHENTICATED') {
      const rest = text.trim().slice(4).trim();
      // Reuse BuyFlow's amount parsing semantics (digits/comma/naira prefix).
      // Safe parse — invalid amounts fall through to the BUY_AMOUNT prompt.
      const amount = parseQuickBuyAmount(rest);
      if (amount !== null) {
        return {
          patch: {
            step: 'BUY_CONFIRM',
            data: { amountNgn: amount },
          },
        };
      }
      // "BUY xyz" or "BUY " with no amount → start the BUY flow at AMOUNT
      return {
        patch: {
          step: 'BUY_AMOUNT',
        },
      };
    }

    // Bare "BUY" with no arg — same as above
    if (upper === 'BUY' && session.role === 'tenant' && session.step === 'TENANT_AUTHENTICATED') {
      return { patch: { step: 'BUY_AMOUNT' } };
    }

    return null;
  }

  // ─── IO helpers — log and continue rather than throw ───────────────────

  private async sendOrLog(phone: Phone, text: string, log: typeof logger): Promise<boolean> {
    try {
      await this.sender.sendMessage({ to: phone, text });
      return true;
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Outbound send failed');
      return false;
    }
  }

  private async saveOrLog(phone: Phone, session: SessionState, log: typeof logger): Promise<void> {
    try {
      await this.sessionStore.set(phone, session);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Session save failed (user may see drift on next message)');
    }
  }

  private async clearOrLog(phone: Phone, log: typeof logger): Promise<void> {
    try {
      await this.sessionStore.clear(phone);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Session clear failed');
    }
  }
}

// ─── Outcome type — observable for tests + ops ─────────────────────────────

export type DispatchOutcome =
  | { kind: 'handled' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: Error };

// ─── Local helpers ─────────────────────────────────────────────────────────

function parseQuickBuyAmount(input: string): number | null {
  // Accept: "2000", "2,000", "₦2000", "2000 naira", "2000 NGN"
  const stripped = input
    .trim()
    .replace(/^(?:₦|ngn|naira)\s*/i, '')
    .replace(/\s*(?:naira|ngn)$/i, '')
    .replace(/,/g, '');
  if (!/^[0-9]+$/.test(stripped)) return null;
  const n = Number(stripped);
  if (!Number.isInteger(n) || n < 100 || n > 1_000_000) return null;
  return n;
}

/**
 * Global commands bypass flow dispatch entirely. Currently MENU and HOME.
 * Kept tiny — anything richer should go in the regular command registry.
 */
function isGlobalCommand(text: string): boolean {
  const m = text.trim().toUpperCase();
  return m === 'MENU' || m === 'HOME';
}
