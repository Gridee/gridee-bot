import type { z } from 'zod';
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
  parsePropertyCode,
  unwrapOrFlow,
} from './helpers';

const MAX_OTP_ATTEMPTS = 3;

/**
 * The tenant onboarding flow.
 *
 * Per SCREENS.md:
 *
 *   WELCOME_ROLE_SELECT      ←─ entry (handled by RoleSelectionFlow)
 *         │
 *   TENANT_REG_NAME          "What is your full name?"
 *         │
 *   TENANT_REG_PHONE         "Enter your phone number..."
 *         │  → POST /api/auth/tenant/register
 *   TENANT_REG_OTP           "Enter the 6-digit code..."
 *         │  → POST /api/auth/verify
 *         │  ← session gets jwt, userId, role
 *   TENANT_REG_PROP_CODE     "Enter the Property Code your landlord gave you..."
 *         │  → POST /api/auth/tenant/link-property
 *         ▼
 *   TENANT_AUTHENTICATED     (terminal — flow.complete; ready for BUY/BALANCE/etc.)
 */
export class TenantOnboardingFlow implements IFlow {
  readonly id = 'TENANT_ONBOARDING';

  private static readonly STEPS: ReadonlySet<SessionStep> = new Set<SessionStep>([
    'TENANT_REG_NAME',
    'TENANT_REG_PHONE',
    'TENANT_REG_OTP',
    'TENANT_REG_PROP_CODE',
  ]);

  handles(step: SessionStep): boolean {
    return TenantOnboardingFlow.STEPS.has(step);
  }

  async handle(ctx: FlowContext, message: string): Promise<FlowResult> {
    switch (ctx.session.step) {
      case 'TENANT_REG_NAME':
        return this.handleName(ctx, message);
      case 'TENANT_REG_PHONE':
        return this.handlePhone(ctx, message);
      case 'TENANT_REG_OTP':
        return this.handleOtp(ctx, message);
      case 'TENANT_REG_PROP_CODE':
        return this.handlePropertyCode(ctx, message);
      default:
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
      reply: ctx.templates.tenantRegPhone(),
      patch: {
        step: 'TENANT_REG_PHONE',
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
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

    const result = await ctx.client.registerTenant({ fullName, phone });
    const unwrapped = unwrapOrFlow(result, ctx.templates, ctx.log);
    if (!unwrapped.ok) return unwrapped.flow;

    return {
      kind: 'advance',
      reply: ctx.templates.tenantRegOtp(),
      patch: {
        step: 'TENANT_REG_OTP',
        data: { phone, otpRef: unwrapped.value.otpRef, otpAttempts: 0 },
      },
    };
  }

  private async handleOtp(ctx: FlowContext, message: string): Promise<FlowResult> {
    const otpRef = readData(ctx, 'otpRef', FlowDataSchemas.otpRef);
    if (otpRef === null) {
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

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
      const flow = backendErrorToFlowResult(result.error, ctx.templates, ctx.log);
      if (flow.kind === 'stay') {
        return mergeStay(flow, { data: { otpAttempts: attempts + 1 } });
      }
      return flow;
    }

    const { jwt, userId, role } = result.value;
    if (role !== 'tenant') {
      ctx.log.error({ role }, 'Backend returned non-tenant role for tenant flow');
      return { kind: 'reset', reply: ctx.templates.errorGeneric() };
    }

    // Save fullName for the welcome message; advance to property code prompt.
    const fullName = readData(ctx, 'fullName', FlowDataSchemas.fullName) ?? 'there';
    return {
      kind: 'advance',
      reply: ctx.templates.tenantRegPropCode(),
      patch: {
        step: 'TENANT_REG_PROP_CODE',
        role: 'tenant',
        jwt,
        userId,
        clearData: true,
        data: { fullName },
      },
    };
  }

  private async handlePropertyCode(ctx: FlowContext, message: string): Promise<FlowResult> {
    const propertyCode = parsePropertyCode(message);
    if (!propertyCode) {
      return { kind: 'stay', reply: ctx.templates.errorInvalidPropertyCode() };
    }

    if (!ctx.session.jwt) {
      return { kind: 'reset', reply: ctx.templates.errorAuthExpired() };
    }

    const result = await ctx.client.linkProperty(ctx.session.jwt, { propertyCode });
    const unwrapped = unwrapOrFlow(result, ctx.templates, ctx.log);
    if (!unwrapped.ok) return unwrapped.flow;

    return {
      kind: 'complete',
      reply: ctx.templates.tenantOnboardingComplete({
        propertyLabel: unwrapped.value.propertyLabel,
        landlordName: unwrapped.value.landlordName,
      }),
      patch: {
        step: 'TENANT_AUTHENTICATED',
        clearData: true,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function readData<S extends z.ZodTypeAny>(
  ctx: FlowContext,
  key: string,
  schema: S,
): z.infer<S> | null {
  const raw = ctx.session.data[key];
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

function mergeStay(stay: { kind: 'stay'; reply: string; patch?: SessionPatch }, extra: SessionPatch): FlowResult {
  return {
    kind: 'stay',
    reply: stay.reply,
    patch: mergePatches(stay.patch ?? {}, extra),
  };
}
