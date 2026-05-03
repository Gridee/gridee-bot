import type {
  AddPropertyRequest,
  AddPropertyResponse,
  BackendError,
  InitiatePaymentRequest,
  InitiatePaymentResponse,
  LinkPropertyRequest,
  LinkPropertyResponse,
  RegisterLandlordRequest,
  RegisterLandlordResponse,
  RegisterTenantRequest,
  RegisterTenantResponse,
  ResendOtpRequest,
  ResendOtpResponse,
  Result,
  VerifyOtpRequest,
  VerifyOtpResponse,
} from '../../src/client';
import {
  BackendApiError,
  BackendAuthError,
  BackendNetworkError,
  Err,
  Ok,
} from '../../src/client';
import type { FlowContext } from '../../src/flows';
import { Phone } from '../../src/lib/phone';
import { newSessionState, type SessionState, type SessionStep } from '../../src/session/types';
import { DefaultTemplates } from '../../src/templates';

// ─────────────────────────────────────────────────────────────────────────────
// Fake BackendClient — every endpoint returns a programmable Result
// ─────────────────────────────────────────────────────────────────────────────

type AnyResult<T> = Result<T, BackendError>;

export class FakeBackendClient {
  registerLandlordResult: AnyResult<RegisterLandlordResponse> = Ok({
    otpRef: 'fake-otp-ref',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  registerTenantResult: AnyResult<RegisterTenantResponse> = Ok({
    otpRef: 'fake-otp-ref',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  verifyOtpResult: AnyResult<VerifyOtpResponse> | null = null;
  resendOtpResult: AnyResult<ResendOtpResponse> = Ok({
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  linkPropertyResult: AnyResult<LinkPropertyResponse> = Ok({
    propertyId: 'p1',
    propertyLabel: 'Surulere Block A',
    landlordName: 'Adeola Bayo',
  });
  addPropertyResult: AnyResult<AddPropertyResponse> = Ok({
    propertyId: 'p1',
    propertyCode: 'GRD-LAG-0042',
    label: 'Surulere Block A',
  });
  initiatePaymentResult: AnyResult<InitiatePaymentResponse> = Ok({
    paymentId: 'pay_1',
    txRef: 'TX_abc',
    amountNgn: 5000,
    expectedGrd: 4.0,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    bankTransfer: {
      accountNumber: '1234567890',
      accountName: 'Gridee Wallet',
      bankName: 'Wema Bank',
    },
  });

  calls = {
    registerLandlord: [] as RegisterLandlordRequest[],
    registerTenant: [] as RegisterTenantRequest[],
    verifyOtp: [] as VerifyOtpRequest[],
    resendOtp: [] as ResendOtpRequest[],
    linkProperty: [] as LinkPropertyRequest[],
    addProperty: [] as AddPropertyRequest[],
    initiatePayment: [] as InitiatePaymentRequest[],
  };

  async registerLandlord(input: RegisterLandlordRequest): Promise<AnyResult<RegisterLandlordResponse>> {
    this.calls.registerLandlord.push(input);
    return this.registerLandlordResult;
  }
  async registerTenant(input: RegisterTenantRequest): Promise<AnyResult<RegisterTenantResponse>> {
    this.calls.registerTenant.push(input);
    return this.registerTenantResult;
  }
  async verifyOtp(input: VerifyOtpRequest): Promise<AnyResult<VerifyOtpResponse>> {
    this.calls.verifyOtp.push(input);
    if (this.verifyOtpResult) return this.verifyOtpResult;
    // Default: succeed
    return Ok({
      jwt: 'jwt.fake.token',
      userId: 'usr_1',
      role: 'landlord',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  async resendOtp(input: ResendOtpRequest): Promise<AnyResult<ResendOtpResponse>> {
    this.calls.resendOtp.push(input);
    return this.resendOtpResult;
  }
  async linkProperty(_jwt: string, input: LinkPropertyRequest): Promise<AnyResult<LinkPropertyResponse>> {
    this.calls.linkProperty.push(input);
    return this.linkPropertyResult;
  }
  async addProperty(_jwt: string, input: AddPropertyRequest): Promise<AnyResult<AddPropertyResponse>> {
    this.calls.addProperty.push(input);
    return this.addPropertyResult;
  }
  async initiatePayment(
    _jwt: string,
    input: InitiatePaymentRequest,
  ): Promise<AnyResult<InitiatePaymentResponse>> {
    this.calls.initiatePayment.push(input);
    return this.initiatePaymentResult;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test FlowContext factory
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeContextOpts {
  step: SessionStep;
  data?: Record<string, unknown>;
  jwt?: string;
  userId?: string;
  role?: 'landlord' | 'tenant' | null;
  client?: FakeBackendClient;
}

export interface TestHarness {
  ctx: FlowContext;
  client: FakeBackendClient;
  capturedLogs: { level: string; obj: object; msg: string }[];
}

export function makeContext(opts: MakeContextOpts): TestHarness {
  const client = opts.client ?? new FakeBackendClient();
  const phone: Phone = Phone.of('+2348031234567');

  const session: SessionState = {
    ...newSessionState({ step: opts.step }),
    role: opts.role ?? null,
    data: opts.data ?? {},
    ...(opts.jwt ? { jwt: opts.jwt } : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
  };

  const capturedLogs: { level: string; obj: object; msg: string }[] = [];
  const log = {
    fatal: (obj: object, msg: string) => capturedLogs.push({ level: 'fatal', obj, msg }),
    error: (obj: object, msg: string) => capturedLogs.push({ level: 'error', obj, msg }),
    warn: (obj: object, msg: string) => capturedLogs.push({ level: 'warn', obj, msg }),
    info: (obj: object, msg: string) => capturedLogs.push({ level: 'info', obj, msg }),
    debug: (obj: object, msg: string) => capturedLogs.push({ level: 'debug', obj, msg }),
    trace: (obj: object, msg: string) => capturedLogs.push({ level: 'trace', obj, msg }),
  };

  const ctx: FlowContext = {
    phone,
    session,
    // Cast: FakeBackendClient implements the same surface area, we don't want
    // to constructor-arg a real one in tests.
    client: client as unknown as FlowContext['client'],
    templates: new DefaultTemplates(),
    log: log as unknown as FlowContext['log'],
  };

  return { ctx, client, capturedLogs };
}

/** Construct a typed BackendApiError for tests. */
export function apiError(code: string, status = 400, details?: Record<string, unknown>): BackendApiError {
  return new BackendApiError(`Test error ${code}`, code, status, details);
}

export function authError(): BackendAuthError {
  return new BackendAuthError('JWT expired', 'UNAUTHORIZED', 401);
}

export function networkError(): BackendNetworkError {
  return new BackendNetworkError('connection refused');
}

export const errResult = <T>(e: BackendError): AnyResult<T> => Err(e);
