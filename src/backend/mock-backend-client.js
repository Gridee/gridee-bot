import { normalisePhone } from '../services/phone.js';

function createCode(index) {
  return `GRD-LAG-${String(index).padStart(4, '0')}`;
}

export class MockBackendClient {
  constructor({ business }) {
    this.business = business;
    this.users = new Map();
    this.properties = new Map();
    this.tenants = new Map();
    this.payments = new Map();
    this.landlordBalances = new Map();
    this.propertyIndex = 1;
  }

  async resolveUser(phone) {
    return { user: this.users.get(normalisePhone(phone)) ?? null };
  }

  async setUserRole({ phone, role }) {
    const key = normalisePhone(phone);
    const existing = this.users.get(key) ?? { id: crypto.randomUUID(), phone: key, name: null };
    const user = { ...existing, role };
    this.users.set(key, user);
    return { user };
  }

  async sendOtp({ phone }) {
    return { sent: true, code: this.business.mockOtpCode };
  }

  async verifyOtp({ code }) {
    return { valid: String(code).trim() === this.business.mockOtpCode };
  }

  async registerLandlord({ phone, name, verificationPhone }) {
    const key = normalisePhone(phone);
    const user = { id: crypto.randomUUID(), phone: key, name, role: 'landlord', verificationPhone: normalisePhone(verificationPhone) };
    this.users.set(key, user);
    this.landlordBalances.set(key, 0);
    return { user };
  }

  async createProperty({ phone, address, flatCount, label }) {
    const landlord = this.users.get(normalisePhone(phone));
    if (!landlord || landlord.role !== 'landlord') throw new Error('Landlord not found');
    const code = createCode(this.propertyIndex++);
    const property = {
      id: crypto.randomUUID(),
      code,
      landlordPhone: normalisePhone(phone),
      landlordName: landlord.name,
      address,
      flatCount,
      label,
      activeTenantCount: 0,
      solarStatus: 'Mocked / Online',
      tenants: [],
    };
    this.properties.set(code, property);
    return { property };
  }

  async getLandlordProperties({ phone }) {
    const key = normalisePhone(phone);
    return { properties: [...this.properties.values()].filter((property) => property.landlordPhone === key) };
  }

  async validatePropertyCode({ code }) {
    const property = this.properties.get(String(code).toUpperCase());
    return { valid: Boolean(property), property: property ?? null };
  }

  async registerTenant({ phone, name, verificationPhone, propertyCode }) {
    const code = String(propertyCode).toUpperCase();
    const property = this.properties.get(code);
    if (!property) return { success: false, reason: 'invalid_property_code' };
    if (property.tenants.length >= property.flatCount) return { success: false, reason: 'property_full' };

    const key = normalisePhone(phone);
    const flatNumber = `Flat ${property.tenants.length + 1}`;
    const tenant = {
      id: crypto.randomUUID(),
      phone: key,
      name,
      role: 'tenant',
      verificationPhone: normalisePhone(verificationPhone),
      propertyCode: code,
      propertyName: property.label,
      flatNumber,
      balanceGrd: 0,
      estimatedHours: 0,
      lastTopupDate: null,
      transactions: [],
    };
    this.users.set(key, { id: tenant.id, phone: key, name, role: 'tenant' });
    this.tenants.set(key, tenant);
    property.tenants.push({ phone: key, name, flatNumber, status: 'active' });
    property.activeTenantCount = property.tenants.length;
    return { success: true, tenant, property };
  }

  async createPaymentIntent({ tenantPhone, amountNaira, paymentMethod }) {
    const key = normalisePhone(tenantPhone);
    const tenant = this.tenants.get(key);
    if (!tenant) throw new Error('Tenant not found');

    const kwhAmount = amountNaira / this.business.kwhRateNaira;
    const grdAmount = kwhAmount;
    const reference = `GRD-TXN-${String(this.payments.size + 1).padStart(5, '0')}`;
    const payment = {
      reference,
      tenantPhone: key,
      amountNaira,
      paymentMethod,
      kwhAmount,
      grdAmount,
      status: 'awaiting_payment',
      bankName: 'Mock Bank',
      accountNumber: '0123456789',
      accountName: 'Gridee Payments Ltd',
      network: 'Mock Mobile Money',
      usdtAmount: (amountNaira / 1600).toFixed(2),
      walletAddress: '0x0000000000000000000000000000000000000000',
      expiresInMinutes: 15,
    };
    this.payments.set(reference, payment);

    // In mock mode we immediately credit after creating the intent so BALANCE can be tested.
    tenant.balanceGrd += grdAmount;
    tenant.estimatedHours = tenant.balanceGrd / 3.2;
    tenant.lastTopupDate = new Date().toISOString().slice(0, 10);
    tenant.transactions.unshift({ date: tenant.lastTopupDate, amountNaira, grdAmount });

    const property = this.properties.get(tenant.propertyCode);
    const landlordBalance = this.landlordBalances.get(property.landlordPhone) ?? 0;
    this.landlordBalances.set(property.landlordPhone, landlordBalance + amountNaira * 0.8);

    return { payment, creditedImmediately: true };
  }

  async getTenantBalance({ phone }) {
    const tenant = this.tenants.get(normalisePhone(phone));
    if (!tenant) throw new Error('Tenant not found');
    return {
      balance: {
        balanceGrd: tenant.balanceGrd,
        estimatedHours: tenant.estimatedHours,
        propertyName: tenant.propertyName,
        lastTopupDate: tenant.lastTopupDate,
      },
    };
  }

  async getTenantHistory({ phone }) {
    const tenant = this.tenants.get(normalisePhone(phone));
    if (!tenant) throw new Error('Tenant not found');
    return { transactions: tenant.transactions.slice(0, 10) };
  }

  async getTenantProperty({ phone }) {
    const tenant = this.tenants.get(normalisePhone(phone));
    if (!tenant) throw new Error('Tenant not found');
    const property = this.properties.get(tenant.propertyCode);
    return { property: { label: property.label, address: property.address, landlordName: property.landlordName, status: 'Connected' } };
  }

  async getLandlordEarnings({ phone }) {
    const key = normalisePhone(phone);
    const properties = [...this.properties.values()].filter((property) => property.landlordPhone === key);
    const totalEarnings = this.landlordBalances.get(key) ?? 0;
    return {
      earnings: {
        totalEarnings,
        propertyCount: properties.length,
        breakdown: properties.map((property) => ({ code: property.code, amount: totalEarnings / Math.max(properties.length, 1) })),
      },
    };
  }

  async listTenants({ phone, propertyCode }) {
    const property = this.properties.get(String(propertyCode).toUpperCase());
    if (!property || property.landlordPhone !== normalisePhone(phone)) return { tenants: [] };
    return { tenants: property.tenants };
  }

  async requestWithdrawal({ phone, channel, amount }) {
    return { withdrawal: { amount, channel, bankName: channel === 'bank' ? 'Saved Bank' : channel, last4: '7891' } };
  }

  async removeTenant({ phone, tenantPhone }) {
    return { tenantName: 'Mock Tenant', propertyName: 'Mock Property' };
  }

  async getPropertyDetails({ phone, code }) {
    return {
      code,
      label: 'Mock Property',
      address: '123 Mock St',
      flat_count: 10,
      activeTenantCount: 2,
      status: 'Active'
    };
  }

  async getHelp({ phone }) {
    const user = this.users.get(normalisePhone(phone));
    return { role: user?.role || 'tenant' };
  }
}
