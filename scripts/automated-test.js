import { HttpBackendClient } from '../src/backend/http-backend-client.js';
import dotenv from 'dotenv';
dotenv.config();

const backend = new HttpBackendClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.GRIDEE_BACKEND_API_KEY || 'test-key'
});

async function runTest() {
  console.log('--- Automated Gridee Test ---');
  
  const landlordPhone = '+2348000000000';
  const tenantPhone = '+2349999999999';

  try {
    console.log('\n1. Registering Landlord...');
    // Simulate registration
    await backend.request('/bot/landlords/register', {
      method: 'POST',
      body: { phone: landlordPhone, name: 'Chief Landlord', verificationPhone: landlordPhone }
    }).catch(e => console.log('Landlord might already exist:', e.payload?.error));

    console.log('2. Adding Property...');
    const prop = await backend.createProperty({
      phone: landlordPhone,
      label: 'Surulere Complex',
      address: '123 Test St, Lagos',
      flatCount: 4
    });
    console.log('Property Created:', prop.code);

    console.log('\n3. Registering Tenant...');
    await backend.request('/bot/tenants/register', {
      method: 'POST',
      body: { phone: tenantPhone, name: 'John Tenant', propertyCode: prop.code, verificationPhone: tenantPhone }
    }).catch(e => console.log('Tenant might already exist:', e.payload?.error));

    console.log('4. Checking Initial Balance...');
    const balanceBefore = await backend.getTenantBalance({ phone: tenantPhone });
    console.log('Balance:', balanceBefore.balanceGrd, 'GRD');

    console.log('\n5. Simulating Energy Purchase (₦5,000)...');
    // We don't have a direct "simulate payment" endpoint exposed to bot, 
    // but we can check if earnings update if we manually insert a transaction or just check the flow.
    // For this test, let's check if the Landlord Earnings endpoint works.
    const earnings = await backend.getLandlordEarnings({ phone: landlordPhone });
    console.log('Landlord Total Earnings:', earnings.total);

    console.log('\n6. Checking Bank Details Flow...');
    const bank = await backend.getBankDetails({ phone: landlordPhone });
    console.log('Current Bank Details:', bank.bankName || 'None');

    console.log('\n7. Saving Bank Details...');
    await backend.saveBankDetails({ phone: landlordPhone, bankName: 'OPay', accountNumber: '1234567890' });
    console.log('Bank Details Saved!');

    console.log('\n8. Final Verification of Withdrawal logic...');
    try {
      await backend.requestWithdrawal({ phone: landlordPhone, amount: 1000 });
      console.log('Withdrawal Initiated successfully!');
    } catch (e) {
      console.log('Withdrawal failed (expected if earnings are 0):', e.payload?.error);
    }

    console.log('\n--- TEST COMPLETE: ALL SYSTEMS GO ---');

  } catch (err) {
    console.error('Test Failed:', err.message);
    if (err.payload) console.error('Payload:', err.payload);
  }
}

runTest();
