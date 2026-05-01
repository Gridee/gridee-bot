import readline from 'readline';

const BOT_URL = 'http://localhost:4100/webhooks/whatsapp';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You> '
});

const phone = 'whatsapp:+2348000000000'; // Default test number

console.log('--- Gridee WhatsApp Bot CLI Test ---');
console.log(`Sending messages as ${phone}`);
console.log('Make sure the bot is running on port 4100 (`npm run dev`)');
console.log('Type your message and press enter. Type exit to quit.\n');
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (text.toLowerCase() === 'exit') {
    process.exit(0);
  }

  try {
    const params = new URLSearchParams();
    params.append('From', phone);
    params.append('Body', text);

    const response = await fetch(BOT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    const result = await response.text();
    
    // Extract the message from TwiML XML
    const match = result.match(/<Message>(.*?)<\/Message>/s);
    if (match) {
      // Decode basic HTML entities for readability in terminal
      const decoded = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      
      console.log('\nBot>\n\x1b[36m%s\x1b[0m\n', decoded.trim());
    } else {
      console.log('\nBot> [No text reply or unsupported format]');
      console.log('Raw:', result);
    }
  } catch (err) {
    console.error('\n[Error connecting to bot] Is it running?', err.message);
  }

  rl.prompt();
});
