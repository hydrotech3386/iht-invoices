// Hydrotech Invoice Tracker — Telegram Notification Script
// Runs daily via GitHub Actions. Sends reminders for unpaid invoices ≥30 days.
// Resends every 15 days. Tracks notification state in Firebase at /invoiceNotifications.

const https = require('https');

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const DB_URL       = process.env.FIREBASE_DB_URL;       // e.g. https://xxxx.firebasedatabase.app
const DB_SECRET    = process.env.FIREBASE_DB_SECRET;

const NOTIFY_AFTER_DAYS    = 30;
const RESEND_INTERVAL_DAYS = 15;

// ---- HTTP helpers ----
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const fbGet  = url            => request('GET',  `${DB_URL}/${url}?auth=${DB_SECRET}`);
const fbPut  = (url, body)    => request('PUT',  `${DB_URL}/${url}?auth=${DB_SECRET}`, body);
const fbPatch= (url, body)    => request('PATCH',`${DB_URL}/${url}?auth=${DB_SECRET}`, body);

function sendTelegram(chatId, text) {
  return request('POST', `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id:    chatId,
    text,
    parse_mode: 'HTML'
  });
}

// ---- Helpers ----
function amountPaid(inv) {
  const pays = Array.isArray(inv.payments)
    ? inv.payments
    : Object.values(inv.payments || {});
  return pays.reduce((s, p) => s + (p.amount || 0), 0);
}
function totalPayable(inv)  { return (inv.amount || 0) + (inv.sst || 0); }
function fmtRM(n)           { return 'RM ' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr + 'T00:00:00').getTime()) / 86400000);
}

// ---- Main ----
async function main() {
  if (!BOT_TOKEN || !DB_URL || !DB_SECRET) {
    console.error('Missing environment variables: TELEGRAM_BOT_TOKEN, FIREBASE_DB_URL, FIREBASE_DB_SECRET');
    process.exit(1);
  }

  // Fetch all data in parallel
  const [invoiceData, usersData, notifData] = await Promise.all([
    fbGet('invoices.json'),
    fbGet('invoiceUsers.json'),
    fbGet('invoiceNotifications.json')
  ]);

  const invObj  = (invoiceData  && invoiceData.invoices)  || {};
  const users   = usersData || {};
  const notifs  = notifData  || {};

  // Firebase returns arrays as objects with numeric string keys via REST
  const invoices = Array.isArray(invObj) ? invObj : Object.values(invObj);

  // Build salesman → Telegram chat ID map from user records
  const chatIdMap = {};
  Object.values(users).forEach(u => {
    if (u.salesman && u.telegramChatId) {
      chatIdMap[u.salesman] = String(u.telegramChatId);
    }
  });

  if (!Object.keys(chatIdMap).length) {
    console.log('No Telegram chat IDs configured for any salesman. Nothing to send.');
    return;
  }

  const now     = Date.now();
  let   sent    = 0;
  let   skipped = 0;

  for (const inv of invoices) {
    if (!inv || !inv.id || !inv.invoiceDate || !inv.salesman) continue;

    const chatId = chatIdMap[inv.salesman];
    if (!chatId) { skipped++; continue; }

    // Skip paid invoices
    const paid  = amountPaid(inv);
    const total = totalPayable(inv);
    if (total > 0 && paid >= total) continue;

    // Check days outstanding
    const days = daysSince(inv.invoiceDate);
    if (days < NOTIFY_AFTER_DAYS) continue;

    // Check if we already notified recently
    const lastNotified = notifs[inv.id] ? notifs[inv.id].lastNotifiedAt : null;
    const shouldNotify = !lastNotified || (now - lastNotified) >= RESEND_INTERVAL_DAYS * 86400000;
    if (!shouldNotify) continue;

    const bal       = Math.max(0, total - paid);
    const isPartial = paid > 0;
    const notifyCount = notifs[inv.id] ? (notifs[inv.id].count || 0) + 1 : 1;

    const msg =
      `⚠️ <b>Invoice Payment Reminder</b>\n\n` +
      `Invoice No: <b>${inv.invoiceNo || '—'}</b>\n` +
      `Customer: ${inv.customer || '—'}\n` +
      `Amount: ${fmtRM(total)}\n` +
      (isPartial
        ? `Balance Due: <b>${fmtRM(bal)}</b>\n`
        : `Status: <b>Unpaid</b>\n`) +
      `Days Outstanding: <b>${days} days</b>\n\n` +
      `Please follow up with the customer for payment.\n` +
      `<i>Reminder #${notifyCount}</i>`;

    try {
      const result = await sendTelegram(chatId, msg);
      if (result.ok) {
        await fbPut(`invoiceNotifications/${inv.id}.json`, {
          lastNotifiedAt: now,
          count:          notifyCount,
          invoiceNo:      inv.invoiceNo || '',
          salesman:       inv.salesman
        });
        console.log(`✓ Sent reminder #${notifyCount} to ${inv.salesman} — ${inv.invoiceNo} (${days}d outstanding)`);
        sent++;
      } else {
        console.error(`✗ Telegram error for ${inv.invoiceNo}: ${result.description}`);
      }
    } catch(e) {
      console.error(`✗ Error notifying for ${inv.invoiceNo}:`, e.message);
    }
  }

  console.log(`\nDone. Sent: ${sent} reminder(s). Skipped (no chat ID): ${skipped}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
