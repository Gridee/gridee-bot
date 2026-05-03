import { z } from 'zod';
import type { SessionStep } from '../session/types';
import type { FlowContext, FlowResult, IFlow } from './IFlow';
import { backendErrorToFlowResult, parseStrictPositiveInt, unwrapOrFlow } from './helpers';

const MIN_NGN = 100;
const MAX_NGN = 1_000_000;

/**
 * The BUY flow.
 *
 * Per SCREENS.md:
 *
 *   BUY_AMOUNT          "How much...?" — accepts an integer in Naira
 *         │
 *   BUY_CONFIRM         "Pay X NGN for Y GRD. (1) Bank (2) Mobile money"
 *         │  → POST /api/payments/initiate
 *         │
 *   AWAITING_PAYMENT    "Waiting for payment to land..."
 *         │
 *         ▼  (terminal — push notification on confirm wakes user up)
 *
 * The dispatcher initiates this flow when:
 *   - User types `BUY <amount>`     → start at BUY_CONFIRM with amount preset
 *   - User types `BUY` alone        → start at BUY_AMOUNT
 *
 * Either way, the flow handles BUY_AMOUNT → BUY_CONFIRM → AWAITING_PAYMENT.
 *
 * NOTE: this flow does NOT handle the payment-confirmed push — that comes
 * from the backend webhook → notification service, which sends a message
 * directly to the user's WhatsApp out-of-band. The session step transitions
 * out of AWAITING_PAYMENT when the user types any new command.
 */
export class BuyFlow implements IFlow {
  readonly id = 'BUY';

  private static readonly STEPS: ReadonlySet<SessionStep> = new Set<SessionStep>([
    'BUY_AMOUNT',
    'BUY_CONFIRM',
    'AWAITING_PAYMENT',
  ]);

  handles(step: SessionStep): boolean {
    return BuyFlow.STEPS.has(step);
  }

  async handle(ctx: FlowContext, message: string): Promise<FlowResult> {
    switch (ctx.session.step) {
      case 'BUY_AMOUNT':
        return this.handleAmount(ctx, message);
      case 'BUY_CONFIRM':
        return this.handleConfirm(ctx, message);
      case 'AWAITING_PAYMENT':
        // Any message during AWAITING_PAYMENT is unhandled by this flow —
        // dispatcher decides if it's a global command (HELP, BALANCE, etc.).
        return { kind: 'passthrough' };
      default:
        return { kind: 'passthrough' };
    }
  }

  // ─── Step handlers ────────────────────────────────────────────────────

  private async handleAmount(ctx: FlowContext, message: string): Promise<FlowResult> {
    const amount = parseAmount(message);
    if (amount === null) {
      return {
        kind: 'stay',
        reply: ctx.templates.errorInvalidAmount({ min: MIN_NGN, max: MAX_NGN }),
      };
    }

    // Compute expected GRD client-side for the confirm screen.
    // Source of truth is the backend; this is just a preview.
    const expectedGrd = computeExpectedGrd(amount);

    return {
      kind: 'advance',
      reply: ctx.templates.buyConfirm({ amountNgn: amount, expectedGrd }),
      patch: {
        step: 'BUY_CONFIRM',
        data: { amountNgn: amount },
      },
    };
  }

  private async handleConfirm(ctx: FlowContext, message: string): Promise<FlowResult> {
    const method = parsePaymentMethod(message);
    if (method === null) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidInput() };
    }

    const amountNgn = readData(ctx, 'amountNgn', z.number().int().min(MIN_NGN).max(MAX_NGN));
    if (amountNgn === null) {
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

    if (!ctx.session.jwt) {
      return { kind: 'reset', reply: ctx.templates.errorAuthExpired() };
    }

    const result = await ctx.client.initiatePayment(ctx.session.jwt, { amountNgn, method });
    if (!result.ok) {
      return backendErrorToFlowResult(result.error, ctx.templates, ctx.log);
    }
    const unwrapped = unwrapOrFlow({ ok: true, value: result.value }, ctx.templates, ctx.log);
    if (!unwrapped.ok) return unwrapped.flow;
    const payment = unwrapped.value;

    // Build the right instructions message based on method
    let reply: string;
    if (method === 'BANK_TRANSFER') {
      if (!payment.bankTransfer) {
        ctx.log.error({ paymentId: payment.paymentId }, 'BANK_TRANSFER initiated but no bankTransfer details');
        return { kind: 'stay', reply: ctx.templates.errorPaymentInitiationFailed() };
      }
      reply = ctx.templates.paymentInstructionsBank({
        amountNgn: payment.amountNgn,
        accountNumber: payment.bankTransfer.accountNumber,
        accountName: payment.bankTransfer.accountName,
        bankName: payment.bankTransfer.bankName,
        txRef: payment.txRef,
        expiresAtIso: payment.expiresAt,
      });
    } else {
      if (!payment.mobileMoney) {
        ctx.log.error({ paymentId: payment.paymentId }, 'MOBILE_MONEY initiated but no mobileMoney details');
        return { kind: 'stay', reply: ctx.templates.errorPaymentInitiationFailed() };
      }
      reply = ctx.templates.paymentInstructionsMobileMoney({
        amountNgn: payment.amountNgn,
        ussdCode: payment.mobileMoney.ussdCode,
        provider: payment.mobileMoney.provider,
        txRef: payment.txRef,
        expiresAtIso: payment.expiresAt,
      });
    }

    return {
      kind: 'advance',
      reply,
      patch: {
        step: 'AWAITING_PAYMENT',
        data: {
          paymentId: payment.paymentId,
          txRef: payment.txRef,
          amountNgn: payment.amountNgn,
          expectedGrd: payment.expectedGrd,
          expiresAt: payment.expiresAt,
          method,
        },
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an amount in Naira. Accepts:
 *   "2000", "2,000", "₦2000", "2000 naira", "2000 NGN"
 * Rejects:
 *   "2000.50" (whole naira only), negative, zero, > MAX_NGN
 */
function parseAmount(input: string): number | null {
  const stripped = input
    .trim()
    .replace(/^(?:₦|ngn|naira)\s*/i, '')
    .replace(/\s*(?:naira|ngn)$/i, '')
    .replace(/,/g, '');
  const n = parseStrictPositiveInt(stripped, MAX_NGN);
  if (n === null) return null;
  if (n < MIN_NGN) return null;
  return n;
}

function parsePaymentMethod(input: string): 'BANK_TRANSFER' | 'MOBILE_MONEY' | null {
  const v = input.trim().toUpperCase();
  if (v === '1' || v === 'BANK' || v === 'BANK_TRANSFER' || v === 'BANK TRANSFER') {
    return 'BANK_TRANSFER';
  }
  if (v === '2' || v === 'MOBILE' || v === 'MOBILE_MONEY' || v === 'MOBILE MONEY') {
    return 'MOBILE_MONEY';
  }
  return null;
}

/**
 * Preview-only GRD calculation. Backend is source of truth; this is just
 * for the confirm screen so the user knows roughly what they're getting.
 *
 * Default rate: ₦1250 = 1 GRD = 1 kWh (matches PRD's example).
 * Hardcoded for MVP; real rate will come from a backend `/rates` endpoint.
 */
function computeExpectedGrd(amountNgn: number): number {
  const NGN_PER_GRD = 1250;
  return Math.round((amountNgn / NGN_PER_GRD) * 100) / 100;
}

function readData<S extends z.ZodTypeAny>(
  ctx: FlowContext,
  key: string,
  schema: S,
): z.infer<S> | null {
  const raw = ctx.session.data[key];
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}
