import type { SessionStep } from '../session/types';
import type { FlowContext, FlowResult, IFlow, SessionPatch } from './IFlow';
import {
  FlowDataSchemas,
  backendErrorToFlowResult,
  isResendKeyword,
  mergePatches,
  parseFullName,
  parsePhoneInput,
  parseOtp,
  parseStrictPositiveInt,
  parseTextLength,
  unwrapOrFlow,
} from './helpers';

const MAX_OTP_ATTEMPTS = 3;

/**
 * The landlord onboarding flow.
 *
 * Per SCREENS.md, this is one continuous state machine:
 *
 *   WELCOME_ROLE_SELECT      ←─ entry (handled by RoleSelectionFlow)
 *         │
 *   LANDLORD_REG_NAME        "What is your full name?"
 *         │
 *   LANDLORD_REG_PHONE       "Enter your phone number..."
 *         │  → POST /api/auth/landlord/register
 *   LANDLORD_REG_OTP         "Enter the 6-digit code..."
 *         │  → POST /api/auth/verify
 *         │  ← session gets jwt, userId, role
 *         │
 *   ADD_PROPERTY_ADDRESS     "Enter the property address:"
 *         │
 *   ADD_PROPERTY_FLAT_COUNT  "How many flats?"
 *         │
 *   ADD_PROPERTY_LABEL       "Give this property a name:"
 *         │  → POST /api/landlords/me/properties
 *         ▼
 *   PROPERTY_REGISTERED      (terminal — flow.complete; session.step =
 *                              LANDLORD_AUTHENTICATED, commands take over)
 */
export class LandlordOnboardingFlow implements IFlow {
  readonly id = 'LANDLORD_ONBOARDING';

  private static readonly STEPS: ReadonlySet<SessionStep> = new Set<SessionStep>([
    'LANDLORD_REG_NAME',
    'LANDLORD_REG_PHONE',
    'LANDLORD_REG_OTP',
    'ADD_PROPERTY_ADDRESS',
    'ADD_PROPERTY_FLAT_COUNT',
    'ADD_PROPERTY_LABEL',
  ]);

  handles(step: SessionStep): boolean {
    return LandlordOnboardingFlow.STEPS.has(step);
  }

  async handle(ctx: FlowContext, message: string): Promise<FlowResult> {
    // Exhaustiveness: TS will flag if a step isn't handled when SessionStep grows
    switch (ctx.session.step) {
      case 'LANDLORD_REG_NAME':
        return this.handleName(ctx, message);
      case 'LANDLORD_REG_PHONE':
        return this.handlePhone(ctx, message);
      case 'LANDLORD_REG_OTP':
        return this.handleOtp(ctx, message);
      case 'ADD_PROPERTY_ADDRESS':
        return this.handlePropertyAddress(ctx, message);
      case 'ADD_PROPERTY_FLAT_COUNT':
        return this.handleFlatCount(ctx, message);
      case 'ADD_PROPERTY_LABEL':
        return this.handleLabel(ctx, message);
      default:
        // This step isn't ours — return passthrough so dispatcher can handle.
        return { kind: 'passthrough' };
    }
  }

  // ─── Step handlers ────────────────────────────────────────────────────

  private async handleName(ctx: FlowContext, message: string): Promise<FlowResult> {
    const name = parseFullName(message);
    if (!name) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidInput() };
    }
    return {
      kind: 'advance',
      reply: ctx.templates.landlordRegPhone(),
      patch: {
        step: 'LANDLORD_REG_PHONE',
        data: { fullName: name },
      },
    };
  }

  private async handlePhone(ctx: FlowContext, message: string): Promise<FlowResult> {
    const phone = parsePhoneInput(message);
    if (!phone) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidInput() };
    }

    const fullName = readData(ctx, 'fullName', FlowDataSchemas.fullName);
    if (fullName === null) {
      // Data corruption — restart
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

    const result = await ctx.client.registerLandlord({ fullName, phone });
    const unwrapped = unwrapOrFlow(result, ctx.templates, ctx.log);
    console.log('registerLandlord result', { unwrapped });
    if (!unwrapped.ok) return unwrapped.flow;

    return {
      kind: 'advance',
      reply: ctx.templates.landlordRegOtp(),
      patch: {
        step: 'LANDLORD_REG_OTP',
        data: { phone, otpRef: unwrapped.value.otpRef, otpAttempts: 0 },
      },
    };
  }

  private async handleOtp(ctx: FlowContext, message: string): Promise<FlowResult> {
    const otpRef = readData(ctx, 'otpRef', FlowDataSchemas.otpRef);
    if (otpRef === null) {
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

    // RESEND keyword handled inline so it can't be mistaken for an OTP.
    if (isResendKeyword(message)) {
      const r = await ctx.client.resendOtp({ otpRef });
      const unwrapped = unwrapOrFlow(r, ctx.templates, ctx.log);
      if (!unwrapped.ok) return unwrapped.flow;
      return {
        kind: 'stay',
        reply: ctx.templates.errorOtpResent(),
        patch: { data: { otpAttempts: 0 } },
      };
    }

    const otp = parseOtp(message);
    if (!otp) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidInput() };
    }

    const attempts = readData(ctx, 'otpAttempts', FlowDataSchemas.otpAttempts) ?? 0;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      return { kind: 'reset', reply: ctx.templates.errorTooManyOtpAttempts() };
    }

    const result = await ctx.client.verifyOtp({ otpRef, otp });
    if (!result.ok) {
      // Special-case: bump attempts on INVALID_OTP rather than just bouncing
      const flow = backendErrorToFlowResult(result.error, ctx.templates, ctx.log);
      if (flow.kind === 'stay') {
        return mergeStay(flow, { data: { otpAttempts: attempts + 1 } });
      }
      return flow;
    }

    const { jwt, userId, role } = result.value;
    if (role !== 'landlord') {
      // Server contradicts us — corrupt state, reset
      ctx.log.error({ role }, 'Backend returned non-landlord role for landlord flow');
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

    // Build welcome + ADD_PROPERTY prompt as a single message — fewer round-trips
    const fullName = readData(ctx, 'fullName', FlowDataSchemas.fullName) ?? 'there';
    const welcome = ctx.templates.welcomeAuthenticated({ fullName, role: 'landlord' });
    const propertyPrompt = ctx.templates.addPropertyAddress();

    return {
      kind: 'advance',
      reply: `${welcome}\n\n${propertyPrompt}`,
      patch: {
        step: 'ADD_PROPERTY_ADDRESS',
        role: 'landlord',
        jwt,
        userId,
        // Wipe sensitive registration data; keep fullName for later.
        clearData: true,
        data: { fullName },
      },
    };
  }

  private async handlePropertyAddress(ctx: FlowContext, message: string): Promise<FlowResult> {
    const address = parseTextLength(message, 5, 500);
    if (!address) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidInput() };
    }
    return {
      kind: 'advance',
      reply: ctx.templates.addPropertyFlatCount(),
      patch: {
        step: 'ADD_PROPERTY_FLAT_COUNT',
        data: { address },
      },
    };
  }

  private async handleFlatCount(ctx: FlowContext, message: string): Promise<FlowResult> {
    const flatCount = parseStrictPositiveInt(message, 1000);
    if (flatCount === null) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidInput() };
    }
    return {
      kind: 'advance',
      reply: ctx.templates.addPropertyLabel(),
      patch: {
        step: 'ADD_PROPERTY_LABEL',
        data: { flatCount },
      },
    };
  }

  private async handleLabel(ctx: FlowContext, message: string): Promise<FlowResult> {
    const label = parseTextLength(message, 2, 100);
    if (!label) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidInput() };
    }

    const address = readData(ctx, 'address', FlowDataSchemas.address);
    const flatCount = readData(ctx, 'flatCount', FlowDataSchemas.flatCount);
    if (address === null || flatCount === null) {
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

    if (!ctx.session.jwt) {
      return { kind: 'reset', reply: ctx.templates.errorAuthExpired() };
    }

    const result = await ctx.client.addProperty(ctx.session.jwt, {
      address,
      flatCount,
      label,
    });
    const unwrapped = unwrapOrFlow(result, ctx.templates, ctx.log);
    if (!unwrapped.ok) return unwrapped.flow;

    return {
      kind: 'complete',
      reply: ctx.templates.propertyRegistered({
        propertyCode: unwrapped.value.propertyCode,
        label: unwrapped.value.label,
      }),
      patch: {
        step: 'LANDLORD_AUTHENTICATED',
        clearData: true,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

import type { z } from 'zod';

/**
 * Read a typed value out of session.data, validated by a Zod schema.
 * Returns null if missing or wrong type — caller decides whether to reset.
 */
function readData<S extends z.ZodTypeAny>(
  ctx: FlowContext,
  key: string,
  schema: S,
): z.infer<S> | null {
  const raw = ctx.session.data[key];
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Add additional patch onto an existing FlowStay. */
function mergeStay(stay: { kind: 'stay'; reply: string; patch?: SessionPatch }, extra: SessionPatch): FlowResult {
  return {
    kind: 'stay',
    reply: stay.reply,
    patch: mergePatches(stay.patch ?? {}, extra),
  };
}
