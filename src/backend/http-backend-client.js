import { normalisePhone } from '../services/phone.js';

export class HttpBackendClient {
  constructor({ baseUrl, apiKey }) {
    if (!baseUrl) throw new Error('GRIDEE_BACKEND_BASE_URL is required when BACKEND_MODE=http');
    if (!apiKey) throw new Error('GRIDEE_BACKEND_API_KEY is required when BACKEND_MODE=http');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = payload.message || `Backend request failed: ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  resolveUser(phone) {
    return this.request('/bot/users/resolve', { method: 'POST', body: { phone: normalisePhone(phone) } });
  }

  setUserRole(input) {
    return this.request('/bot/users/role', { method: 'PATCH', body: input });
  }

  sendOtp(input) {
    return this.request('/bot/otp/send', { method: 'POST', body: input });
  }

  verifyOtp(input) {
    return this.request('/bot/otp/verify', { method: 'POST', body: input });
  }

  registerLandlord(input) {
    return this.request('/bot/landlords/register', { method: 'POST', body: input });
  }

  createProperty(input) {
    return this.request('/bot/properties', { method: 'POST', body: input });
  }

  getLandlordProperties({ landlordPhone }) {
    return this.request(`/bot/landlords/${encodeURIComponent(normalisePhone(landlordPhone))}/properties`);
  }

  validatePropertyCode({ code }) {
    return this.request(`/bot/properties/${encodeURIComponent(String(code).toUpperCase())}/validate`);
  }

  registerTenant(input) {
    return this.request('/bot/tenants/register', { method: 'POST', body: input });
  }

  createPaymentIntent(input) {
    return this.request('/bot/payments/intents', { method: 'POST', body: input });
  }

  getTenantBalance({ phone }) {
    return this.request(`/bot/tenants/${encodeURIComponent(normalisePhone(phone))}/balance`);
  }

  getTenantHistory({ phone }) {
    return this.request(`/bot/tenants/${encodeURIComponent(normalisePhone(phone))}/history`);
  }

  getTenantProperty({ phone }) {
    return this.request(`/bot/tenants/${encodeURIComponent(normalisePhone(phone))}/property`);
  }

  getLandlordEarnings({ phone }) {
    return this.request(`/bot/landlords/${encodeURIComponent(normalisePhone(phone))}/earnings`);
  }

  listTenants({ landlordPhone, propertyCode }) {
    return this.request(`/bot/landlords/${encodeURIComponent(normalisePhone(landlordPhone))}/properties/${encodeURIComponent(propertyCode)}/tenants`);
  }

  requestWithdrawal({ phone, amount }) {
    return this.request(`/bot/landlords/${encodeURIComponent(normalisePhone(phone))}/withdrawals`, {
      method: 'POST',
      body: { amount },
    });
  }

  removeTenant({ phone, tenantPhone }) {
    return this.request(`/bot/landlords/${encodeURIComponent(normalisePhone(phone))}/remove-tenant`, {
      method: 'POST',
      body: { tenantPhone: normalisePhone(tenantPhone) },
    });
  }

  getHelp({ phone }) {
    return this.request(`/bot/users/${encodeURIComponent(normalisePhone(phone))}/help`);
  }

  getPropertyDetails({ phone, code }) {
    return this.request(`/bot/landlords/${encodeURIComponent(normalisePhone(phone))}/properties/${encodeURIComponent(code)}`);
  }
}
