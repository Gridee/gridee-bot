import { describe, expect, it, vi } from 'vitest';
import {
  BackendApiError,
  BackendAuthError,
  BackendNetworkError,
} from '../../src/client/errors';
import { HttpTransport } from '../../src/client/HttpTransport';

const BASE_URL = 'https://api.example.test';

function makeTransport(opts: {
  fetchImpl: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}): HttpTransport {
  const init: ConstructorParameters<typeof HttpTransport>[0] = {
    baseUrl: BASE_URL,
    fetchImpl: opts.fetchImpl,
    sleepImpl: async () => undefined, // skip retry sleeps in tests
    retryBaseDelayMs: 1,
  };
  if (opts.maxRetries !== undefined) init.maxRetries = opts.maxRetries;
  if (opts.timeoutMs !== undefined) init.timeoutMs = opts.timeoutMs;
  return new HttpTransport(init);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpTransport — happy path', () => {
  it('sends a GET and returns the parsed JSON body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { hello: 'world' }));
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await transport.request({ method: 'GET', path: '/api/ping' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(200);
    expect(result.value.body).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.test/api/ping');
  });

  it('builds proper Authorization header from jwt', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    await transport.request({ method: 'GET', path: '/api/x', jwt: 'abc.def.ghi' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer abc.def.ghi');
  });

  it('serializes body as JSON and sets content-type', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { ok: true }));
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    await transport.request({ method: 'POST', path: '/api/x', body: { a: 1 } });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].body).toBe('{"a":1}');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('strips trailing slashes from baseUrl', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const transport = new HttpTransport({
      baseUrl: 'https://api.example.test///',
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await transport.request({ method: 'GET', path: '/x' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.test/x');
  });

  it('rejects path that does not start with /', async () => {
    const transport = makeTransport({ fetchImpl: vi.fn() as unknown as typeof fetch });
    const result = await transport.request({ method: 'GET', path: 'api/x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendNetworkError);
  });
});

describe('HttpTransport — idempotency', () => {
  it('attaches an Idempotency-Key header on POST', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, {}));
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    await transport.request({ method: 'POST', path: '/x', body: {} });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeDefined();
    // Auto-generated UUID v4 — basic shape check
    expect(headers['Idempotency-Key']!.length).toBeGreaterThan(20);
  });

  it('uses the supplied idempotency key when provided', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, {}));
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    await transport.request({
      method: 'POST',
      path: '/x',
      body: {},
      idempotencyKey: 'my-stable-key-123',
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('my-stable-key-123');
  });

  it('does NOT attach Idempotency-Key on GET', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    await transport.request({ method: 'GET', path: '/x' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('reuses the SAME idempotency key across retries', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      if (attempts < 3) return jsonResponse(503, {});
      return jsonResponse(201, { ok: true });
    });
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    await transport.request({ method: 'POST', path: '/x', body: {} });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map((c) => {
      const init = (c as unknown as [string, RequestInit])[1];
      return (init.headers as Record<string, string>)['Idempotency-Key'];
    });
    // All retries must use the same key — otherwise idempotency on the
    // backend is useless because it sees three different operations.
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });
});

describe('HttpTransport — retry behavior', () => {
  it('retries on 5xx and succeeds on second attempt', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      if (attempts === 1) return jsonResponse(503, {});
      return jsonResponse(200, { ok: true });
    });
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await transport.request({ method: 'GET', path: '/x' });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on network error and succeeds', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('ECONNRESET');
      return jsonResponse(200, { ok: true });
    });
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await transport.request({ method: 'GET', path: '/x' });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: { code: 'VALIDATION_FAILED', message: 'bad' } }),
    );
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await transport.request({ method: 'GET', path: '/x' });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries 5xx attempts', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, {}));
    const transport = makeTransport({
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 2,
    });
    const result = await transport.request({ method: 'GET', path: '/x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendApiError);
    // Initial attempt + 2 retries = 3 total
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('HttpTransport — error mapping', () => {
  it('parses standard error envelope into BackendApiError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, {
        error: { code: 'INVALID_OTP', message: 'Wrong code', details: { attemptsLeft: 2 } },
      }),
    );
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await transport.request({ method: 'POST', path: '/x', body: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendApiError);
    const err = result.error as BackendApiError;
    expect(err.code).toBe('INVALID_OTP');
    expect(err.httpStatus).toBe(400);
    expect(err.details).toEqual({ attemptsLeft: 2 });
  });

  it('maps 401 to BackendAuthError specifically', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired' } }),
    );
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await transport.request({ method: 'GET', path: '/x', jwt: 'expired' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendAuthError);
  });

  it('synthesizes an envelope when backend returns plain 4xx without one', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const transport = makeTransport({ fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await transport.request({ method: 'GET', path: '/x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendApiError);
    const err = result.error as BackendApiError;
    expect(err.httpStatus).toBe(404);
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('returns BackendNetworkError on AbortError (timeout)', async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const transport = makeTransport({
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
    const result = await transport.request({ method: 'GET', path: '/x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BackendNetworkError);
    expect(result.error.message).toMatch(/timed out/);
  });
});
