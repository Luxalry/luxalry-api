import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import crypto from 'crypto';

// Configuration
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ESCALATION_SECRET = process.env.ESCALATION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!ESCALATION_SECRET) throw new Error('Critical: SUPABASE_SERVICE_ROLE_KEY is missing');

// --- [إضافة] Supabase Client ---
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function logAccessToSupabase(data) {
    try {
        await supabase.from('access_logs').insert({
            request_id: data.requestId,
            ip_address: data.ip,
            user_agent: data.ua,
            username: data.username,
            action: data.action,
            status: data.status,
            details: data.details
        });
    } catch (e) { console.error('DB Log Error:', e.message); }
}

// Helper: Connect to Google Sheet (Audit Log)
async function _getSafeDocConnection() {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    if (!spreadsheetId || !serviceAccountEmail || !privateKey) {
        throw new Error('Google Sheets credentials missing');
    }

    const serviceAccountAuth = new JWT({
        email: serviceAccountEmail,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await doc.loadInfo();
    return doc;
}

// Helper: Get or Create Access Log Sheet
async function _getAccessLogSheet(doc) {
    let sheet = doc.sheetsByTitle["Access_Logs"];
    if (!sheet) {
        sheet = await doc.addSheet({ headerValues: ['Request ID', 'Timestamp', 'IP', 'User Agent', 'Context User', 'Status', 'Reviewer'] });
        await sheet.updateProperties({ title: "Access_Logs" });
    }
    return sheet;
}

// Helper: Sign Token (HMAC SHA256)
function signToken(payload) {
    const data = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', ESCALATION_SECRET).update(data).digest('hex');
    return Buffer.from(data).toString('base64') + '.' + signature;
}

// Helper: Send Telegram Message
async function sendTelegramMessage(text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: TG_CHAT_ID, text: text, parse_mode: 'Markdown' };
    if (replyMarkup) body.reply_markup = replyMarkup;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

// Helper: Edit Telegram Message
async function editTelegramMessage(messageId, text) {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/editMessageText`;
    const body = { chat_id: TG_CHAT_ID, message_id: messageId, text: text, parse_mode: 'Markdown' };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Helper: Answer Callback Query
async function answerCallbackQuery(callbackQueryId, text) {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/answerCallbackQuery`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text: text })
    });
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { action } = req.query;

    try {
        // 1. Request Access
        if (action === 'request' && req.method === 'POST') {
            const { username, password } = req.body;

            // [SECURITY FIX] Restrict Emergency Access to Master Admin Only
            // This prevents Supabase users from using the escalation flow
            if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
                return res.status(401).json({ error: 'Invalid Emergency Credentials' });
            }

            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            const userAgent = req.headers['user-agent'] || 'Unknown';
            const requestId = crypto.randomUUID();

            // Log to Sheet
            const doc = await _getSafeDocConnection();
            const sheet = await _getAccessLogSheet(doc);
            await sheet.addRow({
                'Request ID': requestId,
                'Timestamp': new Date().toISOString(),
                'IP': ip,
                'User Agent': userAgent,
                'Context User': username || 'Anonymous',
                'Status': 'pending',
                'Reviewer': '-'
            });

            // --- (NEW) Dual-Log to Supabase ---
            logAccessToSupabase({
                requestId: requestId,
                ip: ip,
                ua: userAgent,
                username: username,
                action: 'escalation_request',
                status: 'pending',
                details: { context: 'access.js' }
            });
            // ----------------------------------

            // Send Telegram Notification
            const message = `🚨 *Escalation Request*\n\n*User:* \`${username}\`\n*IP:* \`${ip}\`\n*ID:* \`${requestId.split('-')[0]}\`\n\n_Approve access for 10 minutes?_`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '✅ Approve', callback_data: `approve:${requestId}` },
                        { text: '❌ Deny', callback_data: `deny:${requestId}` }
                    ]
                ]
            };
            await sendTelegramMessage(message, keyboard);

            return res.status(200).json({ success: true, requestId });
        }

        // 2. Check Status (Polling)
        if (action === 'status' && req.method === 'GET') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'Missing ID' });

            const doc = await _getSafeDocConnection();
            const sheet = await _getAccessLogSheet(doc);
            const rows = await sheet.getRows();
            const row = rows.find(r => r.get('Request ID') === id);

            if (!row) return res.status(404).json({ error: 'Request not found' });

            const status = row.get('Status');
            if (status === 'approved') {
                // Generate Token (Valid for 10 mins)
                const payload = {
                    scope: 'admin:escalation',
                    rid: id,
                    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                    ua: req.headers['user-agent'] || 'Unknown', // [SECURITY] Context Binding
                    jti: crypto.randomUUID(), // [SECURITY] Anti-Replay
                    iat: Date.now(),
                    exp: Date.now() + (10 * 60 * 1000) // 10 mins
                };
                const token = signToken(payload);
                return res.status(200).json({ status: 'approved', token });
            }

            return res.status(200).json({ status: status });
        }

        // 3. Telegram Webhook
        if (action === 'telegram' && req.method === 'POST') {
            const update = req.body;

            if (update.callback_query) {
                const cb = update.callback_query;
                const data = cb.data; // approve:uuid or deny:uuid
                const [decision, requestId] = data.split(':');
                const reviewer = cb.from.username || cb.from.first_name;

                // Update Sheet
                const doc = await _getSafeDocConnection();
                const sheet = await _getAccessLogSheet(doc);
                const rows = await sheet.getRows();
                const row = rows.find(r => r.get('Request ID') === requestId);

                if (row) {
                    const currentStatus = row.get('Status');
                    if (currentStatus === 'pending') {
                        row.assign({ 'Status': decision === 'approve' ? 'approved' : 'denied', 'Reviewer': reviewer });
                        await row.save();

                        // Edit Message
                        const icon = decision === 'approve' ? '✅' : '❌';
                        const newText = `🚨 *Escalation Request*\n\n*ID:* \`${requestId.split('-')[0]}\`\n*Status:* ${icon} ${decision.toUpperCase()} by ${reviewer}`;
                        await editTelegramMessage(cb.message.message_id, newText);
                        await answerCallbackQuery(cb.id, `Request ${decision}d`);
                    } else {
                        await answerCallbackQuery(cb.id, 'Request already processed');
                    }
                } else {
                    await answerCallbackQuery(cb.id, 'Request not found');
                }
            }

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Invalid action' });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
