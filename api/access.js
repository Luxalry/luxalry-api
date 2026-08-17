import crypto from 'crypto';
import { handleAdminCors } from './utils.js';

// Configuration
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ESCALATION_SECRET = process.env.ESCALATION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!ESCALATION_SECRET) throw new Error('Critical: SUPABASE_SERVICE_ROLE_KEY is missing');

// --- [إضافة] Supabase Client ---
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function logAccessToSupabase(data) {
    const { error } = await supabase.from('access_logs').insert({
        request_id: data.requestId,
        ip_address: data.ip,
        user_agent: data.ua,
        username: data.username,
        action: data.action,
        status: data.status,
        details: data.details
    });
    if (error) {
        console.error('DB Log Error:', error.message);
        throw new Error('Database Error');
    }
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
    if (handleAdminCors(req, res)) {
        return res.status(200).end();
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

            // Log to Supabase (Single Source of Truth)
            await logAccessToSupabase({
                requestId: requestId,
                ip: ip,
                ua: userAgent,
                username: username,
                action: 'escalation_request',
                status: 'pending',
                details: { context: 'access.js' }
            });

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

            const { data: row, error } = await supabase
                .from('access_logs')
                .select('status')
                .eq('request_id', id)
                .single();

            if (error || !row) return res.status(404).json({ error: 'Request not found' });

            const status = row.status;
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

                // Fetch current state
                const { data: existingRow, error: fetchError } = await supabase
                    .from('access_logs')
                    .select('status, details')
                    .eq('request_id', requestId)
                    .single();

                if (fetchError || !existingRow) {
                    await answerCallbackQuery(cb.id, 'Request not found');
                    return res.status(200).json({ success: true });
                }

                if (existingRow.status === 'pending') {
                    // Merge reviewer into details
                    const newDetails = { ...(existingRow.details || {}), reviewer: reviewer };

                    // Atomic update: only update if STILL pending
                    const { data, error } = await supabase
                        .from('access_logs')
                        .update({ 
                            status: decision === 'approve' ? 'approved' : 'denied',
                            details: newDetails
                        })
                        .eq('request_id', requestId)
                        .eq('status', 'pending')
                        .select();

                    if (data && data.length > 0) {
                        // Edit Message
                        const icon = decision === 'approve' ? '✅' : '❌';
                        const newText = `🚨 *Escalation Request*\n\n*ID:* \`${requestId.split('-')[0]}\`\n*Status:* ${icon} ${decision.toUpperCase()} by ${reviewer}`;
                        await editTelegramMessage(cb.message.message_id, newText);
                        await answerCallbackQuery(cb.id, `Request ${decision}d`);
                    } else {
                        // Another concurrent request processed it first
                        await answerCallbackQuery(cb.id, 'Request already processed');
                    }
                } else {
                    await answerCallbackQuery(cb.id, 'Request already processed');
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
