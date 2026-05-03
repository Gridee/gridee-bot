import {
  AddPropertyRequestSchema,
  AddPropertyResponseSchema,
  BalanceResponseSchema,
  EarningsResponseSchema,
  HistoryResponseSchema,
  InitiatePaymentRequestSchema,
  InitiatePaymentResponseSchema,
  LinkPropertyRequestSchema,
  LinkPropertyResponseSchema,
  ListPropertiesResponseSchema,
  ListTenantsResponseSchema,
  RegisterLandlordRequestSchema,
  RegisterLandlordResponseSchema,
  RegisterTenantRequestSchema,
  RegisterTenantResponseSchema,
  RemoveTenantRequestSchema,
  RemoveTenantResponseSchema,
  ResendOtpRequestSchema,
  ResendOtpResponseSchema,
  VerifyOtpRequestSchema,
  VerifyOtpResponseSchema,
  WithdrawRequestSchema,
  WithdrawResponseSchema,
  type AddPropertyRequest,
  type AddPropertyResponse,
  type BalanceResponse,
  type EarningsResponse,
  type HistoryResponse,
  type InitiatePaymentRequest,
  type InitiatePaymentResponse,
  type LinkPropertyRequest,
  type LinkPropertyResponse,
  type ListPropertiesResponse,
  type ListTenantsResponse,
  type RegisterLandlordRequest,
  type RegisterLandlordResponse,
  type RegisterTenantRequest,
  type RegisterTenantResponse,
  type RemoveTenantRequest,
  type RemoveTenantResponse,
  type ResendOtpRequest,
  type ResendOtpResponse,
  type VerifyOtpRequest,
  type VerifyOtpResponse,
  type WithdrawRequest,
  type WithdrawResponse,
} from './contracts';
import {
  type BackendError,
  Err,
  type Result,
} from './errors';
import {
  HttpTransport,
  type HttpTransportOptions,
  type RequestOptions,
  validateRequest,
  validateResponse,
} from './HttpTransport';
import type { z } from 'zod';

export type BackendClientOptions = HttpTransportOptions;

/**
 * Typed HTTP client for the gridee-backend API.
 *
 * Every method:
 *   1. Validates the request against its Zod schema (catches bot-side bugs)
 *   2. Calls the transport (handles retry/timeout/idempotency)
 *   3. Validates the response against its Zod schema (catches drift)
 *   4. Returns Result<Response, BackendError> — never throws
 *
 * Authenticated endpoints take a `jwt` argument. Unauthenticated endpoints
 * (registration, OTP verify) do not.
 */
export class BackendClient {
  private readonly transport: HttpTransport;

  constructor(opts: BackendClientOptions) {
    this.transport = new HttpTransport(opts);
  }

  // ─── AUTH ─────────────────────────────────────────────────────────────

  registerLandlord(input: RegisterLandlordRequest): Promise<Result<RegisterLandlordResponse, BackendError>> {
    return this.callPublic({
      endpoint: '/api/auth/landlord/register',
      method: 'POST',
      requestSchema: RegisterLandlordRequestSchema,
      responseSchema: RegisterLandlordResponseSchema,
      body: input,
    });
  }

  registerTenant(input: RegisterTenantRequest): Promise<Result<RegisterTenantResponse, BackendError>> {
    return this.callPublic({
      endpoint: '/api/auth/tenant/register',
      method: 'POST',
      requestSchema: RegisterTenantRequestSchema,
      responseSchema: RegisterTenantResponseSchema,
      body: input,
    });
  }

  verifyOtp(input: VerifyOtpRequest): Promise<Result<VerifyOtpResponse, BackendError>> {
    return this.callPublic({
      endpoint: '/api/auth/verify',
      method: 'POST',
      requestSchema: VerifyOtpRequestSchema,
      responseSchema: VerifyOtpResponseSchema,
      body: input,
    });
  }

  resendOtp(input: ResendOtpRequest): Promise<Result<ResendOtpResponse, BackendError>> {
    return this.callPublic({
      endpoint: '/api/auth/resend',
      method: 'POST',
      requestSchema: ResendOtpRequestSchema,
      responseSchema: ResendOtpResponseSchema,
      body: input,
    });
  }

  linkProperty(jwt: string, input: LinkPropertyRequest): Promise<Result<LinkPropertyResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/auth/tenant/link-property',
      method: 'POST',
      jwt,
      requestSchema: LinkPropertyRequestSchema,
      responseSchema: LinkPropertyResponseSchema,
      body: input,
    });
  }

  // ─── LANDLORD — properties ────────────────────────────────────────────

  addProperty(jwt: string, input: AddPropertyRequest): Promise<Result<AddPropertyResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/landlords/me/properties',
      method: 'POST',
      jwt,
      requestSchema: AddPropertyRequestSchema,
      responseSchema: AddPropertyResponseSchema,
      body: input,
    });
  }

  listProperties(jwt: string): Promise<Result<ListPropertiesResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/landlords/me/properties',
      method: 'GET',
      jwt,
      responseSchema: ListPropertiesResponseSchema,
    });
  }

  listTenants(jwt: string, propertyId: string): Promise<Result<ListTenantsResponse, BackendError>> {
    return this.callAuthed({
      endpoint: `/api/landlords/me/properties/${encodeURIComponent(propertyId)}/tenants`,
      method: 'GET',
      jwt,
      responseSchema: ListTenantsResponseSchema,
    });
  }

  removeTenant(jwt: string, input: RemoveTenantRequest): Promise<Result<RemoveTenantResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/landlords/me/tenants/remove',
      method: 'POST',
      jwt,
      requestSchema: RemoveTenantRequestSchema,
      responseSchema: RemoveTenantResponseSchema,
      body: input,
    });
  }

  // ─── LANDLORD — earnings ──────────────────────────────────────────────

  getEarnings(jwt: string): Promise<Result<EarningsResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/landlords/me/earnings',
      method: 'GET',
      jwt,
      responseSchema: EarningsResponseSchema,
    });
  }

  withdraw(jwt: string, input: WithdrawRequest): Promise<Result<WithdrawResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/landlords/me/withdraw',
      method: 'POST',
      jwt,
      requestSchema: WithdrawRequestSchema,
      responseSchema: WithdrawResponseSchema,
      body: input,
    });
  }

  // ─── TENANT ───────────────────────────────────────────────────────────

  getBalance(jwt: string): Promise<Result<BalanceResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/tenants/me/balance',
      method: 'GET',
      jwt,
      responseSchema: BalanceResponseSchema,
    });
  }

  getHistory(jwt: string, limit = 20): Promise<Result<HistoryResponse, BackendError>> {
    return this.callAuthed({
      endpoint: `/api/tenants/me/history?limit=${encodeURIComponent(String(limit))}`,
      method: 'GET',
      jwt,
      responseSchema: HistoryResponseSchema,
    });
  }

  initiatePayment(
    jwt: string,
    input: InitiatePaymentRequest,
  ): Promise<Result<InitiatePaymentResponse, BackendError>> {
    return this.callAuthed({
      endpoint: '/api/payments/initiate',
      method: 'POST',
      jwt,
      requestSchema: InitiatePaymentRequestSchema,
      responseSchema: InitiatePaymentResponseSchema,
      body: input,
    });
  }

  // ─── Internal — composition helpers ───────────────────────────────────

  private async callPublic<TReq extends z.ZodTypeAny, TRes extends z.ZodTypeAny>(args: {
    endpoint: string;
    method: RequestOptions['method'];
    requestSchema?: TReq;
    responseSchema: TRes;
    body?: unknown;
  }): Promise<Result<z.infer<TRes>, BackendError>> {
    return this.dispatch({ ...args });
  }

  private async callAuthed<TReq extends z.ZodTypeAny, TRes extends z.ZodTypeAny>(args: {
    endpoint: string;
    method: RequestOptions['method'];
    jwt: string;
    requestSchema?: TReq;
    responseSchema: TRes;
    body?: unknown;
  }): Promise<Result<z.infer<TRes>, BackendError>> {
    return this.dispatch({ ...args });
  }

  private async dispatch<TReq extends z.ZodTypeAny, TRes extends z.ZodTypeAny>(args: {
    endpoint: string;
    method: RequestOptions['method'];
    jwt?: string;
    requestSchema?: TReq;
    responseSchema: TRes;
    body?: unknown;
  }): Promise<Result<z.infer<TRes>, BackendError>> {
    // 1. Request validation (only for POSTs/PATCHes — GETs have no body)
    let validatedBody: unknown = undefined;
    if (args.requestSchema && args.body !== undefined) {
      const reqResult = validateRequest(args.requestSchema, args.body, args.endpoint);
      if (!reqResult.ok) return Err(reqResult.error);
      validatedBody = reqResult.value;
    } else if (args.body !== undefined) {
      validatedBody = args.body;
    }

    // 2. Transport call
    const reqOpts: RequestOptions = {
      method: args.method,
      path: args.endpoint,
    };
    if (validatedBody !== undefined) reqOpts.body = validatedBody;
    if (args.jwt) reqOpts.jwt = args.jwt;

    const transportResult = await this.transport.request(reqOpts);
    if (!transportResult.ok) return Err(transportResult.error);

    // 3. Response validation
    return validateResponse(args.responseSchema, transportResult.value.body, args.endpoint);
  }
}
