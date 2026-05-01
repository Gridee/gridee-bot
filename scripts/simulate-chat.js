import fs from 'fs';

const BOT_URL = 'http://localhost:4100/webhooks/whatsapp';
const phone = 'whatsapp:+2348000000000';

async function sendMessage(text, fromPhone = phone) {
  console.log(`\nYou (${fromPhone.replace('whatsapp:', '')})> ${text}`);
  const params = new URLSearchParams();
  params.append('From', fromPhone);
  params.append('Body', text);

  try {
    const response = await fetch(BOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const result = await response.text();
    const match = result.match(/<Message>(.*?)<\/Message>/s);
    if (match) {
      const decoded = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\r/g, ''); // Strip carriage returns to prevent terminal scrambling
      console.log(`Bot>\n\x1b[36m${decoded.trim()}\x1b[0m`);
    } else {
      console.log(`Bot> [No text reply]`);
    }
  } catch (err) {
    console.error(`[Error] ${err.message}`);
  }
}

async function runTest() {
  console.log('--- Gridee Bot Automated Regression ---');
  
  // 1. Onboarding & Registration
  await sendMessage('CANCEL');
  await sendMessage('START');
  await sendMessage('1'); // Landlord
  await sendMessage('John Doe'); // Name
  await sendMessage('08012345678'); // Verification Phone
  await sendMessage('123456'); // OTP (Mock)

  // 2. Add Property Flow
  await sendMessage('ADD PROPERTY');
  await sendMessage('123 Main St, Lagos');
  await sendMessage('10');
  await sendMessage('Main Block');

  // 3. Remove Tenant (simulate failure/prompt)
  await sendMessage('REMOVE TENANT 2348000000001');

  // 4. Help Command
  await sendMessage('HELP');

  console.log('\n--- Tenant Regression ---');
  const tenantPhone = 'whatsapp:+2348000000001';

  // Register Tenant
  await sendMessage('CANCEL', tenantPhone);
  await sendMessage('START', tenantPhone);
  await sendMessage('2', tenantPhone); // Tenant
  await sendMessage('Jane Doe', tenantPhone); // Name
  await sendMessage('08099999999', tenantPhone); // Verification Phone
  await sendMessage('123456', tenantPhone); // OTP (Mock)
  await sendMessage('GRD-LAG-0001', tenantPhone); // Property Code

  // Tenant Commands
  await sendMessage('MY PROPERTY', tenantPhone);
  await sendMessage('HELP', tenantPhone);
  
  console.log('\n--- Regression Complete ---');
}

runTest();
