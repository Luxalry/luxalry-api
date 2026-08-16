import TelegramBot from 'node-telegram-bot-api';

import { validateEmail, normalizePhone, sanitizeString, sanitizeTelegramHTML } from './utils.js';
import crypto from 'crypto';
import SibApiV3Sdk from 'sib-api-v3-sdk'; // [إضافة] مكتبة البريد
/*import { emailTemplates } from './email-templates.js';*/
import { sendWhatsAppConfirmation } from './whatsapp.js'; // [إضافة] وحدة الواتساب
import { processOrderLifecycle } from './order-lifecycle.js';

// --- [إضافة جديدة] إعدادات لتعطيل معالجة Vercel التلقائية ---
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- [إضافة] Supabase Client ---
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- [إضافة] دالة الكتابة في Supabase ---
async function writeToSupabase(data) {
  try {
    const { data: insertedData, error } = await supabase.from('leads').insert({
      order_id: data.orderId,
      full_name: data.clientName,
      email: data.clientEmail,
      phone: data.clientPhone,

      // --- E-commerce Fields ---
      product_name: data.productTitle,
      product_sku: data.productSku,
      quantity: data.productVariant,
      address: data.clientAddress,
      note: data.note,
      delivery_note: data.delivery_note,
      is_external: data.is_external,
      // -------------------------

      // --- Export State Initialization ---
      ...(data.is_external ? {
        export_status: 'PENDING',
        export_attempts: 0
      } : {
        export_status: null,
        export_attempts: 0
      }),
      // -----------------------------------

      status: data.paymentStatus,
      amount: data.amount,
      currency: data.currency,
      payment_method: data.paymentMethod,
      transaction_id: data.transactionId,
      cashplus_code: data.cashplusCode,
      last4_digits: data.last4,
      lang: data.lang,
      utm_source: data.utm_source,
      utm_medium: data.utm_medium,
      utm_campaign: data.utm_campaign,
      utm_term: data.utm_term,
      utm_content: data.utm_content,
      utm_id: data.utm_id,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      last_updated_by: 'System'
    }).select('id').single();

    if (error) {
      if (error.code === '23505') { // Unique constraint violation (duplicate order_id)
        console.log(`Order ${data.orderId} already exists. Treating as idempotent duplicate and preserving existing data.`);
        return { success: true, isDuplicate: true }; 
      }
      throw error;
    }
    
    console.log("Successfully saved to Supabase");
    return { success: true, id: insertedData.id, isDuplicate: false };
  } catch (e) {
    console.error("Supabase Write Error:", e.message);
    return { success: false };
  }
}

// --- [إضافة جديدة] دالة لقراءة البيانات الخام ---
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// 1. إعدادات الأمان
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// [تحديث] دعم عدة مستلمين مفصولين بفاصلة
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim()).filter(Boolean);
const YOUCAN_PRIVATE_KEY = process.env.YOUCAN_PRIVATE_KEY;

// إعدادات البريد (Brevo)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_SENDER_ADDRESS = process.env.EMAIL_SENDER_ADDRESS;
const EMAIL_SENDER_NAME = "Luxalry";

// التحقق من المتغيرات البيئية
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
  console.error('CRITICAL: Missing required environment variables for notify service');
}


// ترجمة الرسائل (Telegram)
const telegramTranslations = {
  ar: {
    title: "<b>طلب جديد</b>",
    product: "<b>المنتج:</b>",
    quantity: "<b>الكمية:</b>",
    address: "<b>العنوان:</b>",
    name: "<b>الاسم:</b>",
    phone: "<b>الهاتف:</b>",
    email: "<b>الإيميل:</b>",
    note: "<b>ملاحظات التوصيل:</b>",
    status: "<b>الحالة:</b>",
    req_id: "<b>رقم الطلب:</b>",
    method: "<b>طريقة الدفع:</b>",
    amount: "<b>المبلغ:</b>",
    lang: "<b>اللغة:</b>"
  },
  fr: {
    title: "<b>Nouvelle Commande</b> ",
    product: "<b>Produit:</b>",
    quantity: "<b>Quantité:</b>",
    address: "<b>Adresse:</b>",
    name: "<b>Nom:</b>",
    phone: "<b>Téléphone:</b>",
    email: "<b>E-mail:</b>",
    note: "<b>Note de livraison:</b>",
    status: "<b>Statut:</b>",
    req_id: "<b>ID Commande:</b>",
    method: "<b>Méthode:</b>",
    amount: "<b>Montant:</b>",
    lang: "<b>Langue:</b>"
  },
  en: {
    title: "<b>New Order</b> ",
    product: "<b>Product:</b>",
    quantity: "<b>Quantity:</b>",
    address: "<b>Address:</b>",
    name: "<b>Name:</b>",
    phone: "<b>Phone:</b>",
    email: "<b>Email:</b>",
    note: "<b>Delivery Note:</b>",
    status: "<b>Status:</b>",
    req_id: "<b>Order ID:</b>",
    method: "<b>Method:</b>",
    amount: "<b>Amount:</b>",
    lang: "<b>Lang:</b>"
  }
};

// قوالب البريد الإلكتروني (نستخدم القوالب المشتركة الآن)
/*const emailConfirmationTemplates = emailTemplates.payment_confirmation;*/



function verifyYouCanSignature(privateKey, payload, receivedSignature) {
  if (!privateKey || !receivedSignature) return false;

  // إذا كان الـ payload نصاً (وهو ما نريده) نستخدمه، وإلا نحوله (للاحتياط)
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);

  const signature = crypto
    .createHmac('sha256', privateKey)
    .update(content)
    .digest('hex');

  return signature === receivedSignature;
}

// دالة إرسال البريد (Brevo)
/*
async function sendConfirmationEmail(data) {
  if (!BREVO_API_KEY || !EMAIL_SENDER_ADDRESS) {
    console.warn("Skipping email: Brevo not configured.");
    return;
  }

  try {
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    apiKey.apiKey = BREVO_API_KEY;

    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

    const lang = emailConfirmationTemplates[data.lang] ? data.lang : 'fr';
    const template = emailConfirmationTemplates[lang];

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = template.subject;
    sendSmtpEmail.htmlContent = `<html><body>${template.body(data)}</body></html>`;
    sendSmtpEmail.sender = { name: EMAIL_SENDER_NAME, email: EMAIL_SENDER_ADDRESS };
    sendSmtpEmail.to = [{ email: data.clientEmail, name: data.clientName }];

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`Confirmation email sent to ${data.clientEmail}`);
  } catch (error) {
    console.error("Email Sending Error:", error.message);
  }
}
*/
export default async (req, res) => {
  // CORS Setup
  const allowedOrigins = [
    'https://dermossence.luxalry.shop',
    'https://luxalry.ma',
    'https://luxalry.shop',
    'https://.luxalry.shop',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // --- Meta WhatsApp Webhook Verification (GET) ---
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // We only process Meta verification GET requests. Any other GET is 403.
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ message: 'Forbidden' });
  }

  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  let bot;

  try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
    // 1. قراءة البيانات الخام (Raw Body)
    const rawBody = await getRawBody(req);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError);
      return res.status(400).json({ message: 'Invalid JSON' });
    }

    // --- Security Check: Verify YouCanPay Signature ---
    const signature = req.headers['youcan-pay-signature'] || req.headers['x-youcanpay-signature'];

    console.log("Security Debug:", {
      hasPrivateKey: !!YOUCAN_PRIVATE_KEY,
      receivedSignature: signature ? "Yes (Hidden)" : "Missing"
    });

    if (YOUCAN_PRIVATE_KEY) {
      if (!signature) {
        console.error('Missing Webhook Signature!');
        return res.status(401).json({ message: 'Missing Signature' });
      }

      // [مهم] نمرر rawBody للتحقق بدلاً من body
      const isValid = verifyYouCanSignature(YOUCAN_PRIVATE_KEY, rawBody, signature);

      if (!isValid) {
        console.error('Invalid Webhook Signature detected!');
        return res.status(401).json({ message: 'Invalid Signature' });
      }
      console.log('Webhook Signature Verified ✅');
    } else {
      console.warn('WARNING: Skipping signature verification (YOUCAN_PRIVATE_KEY is missing)');
    }
    // --------------------------------------------------

    // --- SAFELY CAPTURE RAW PAYLOAD FOR DISCOVERY ---
    try {
      if (supabase) {
        await supabase.from('webhook_event_debug').insert({
          raw_payload: body
        });
      }
    } catch (captureErr) {
      console.error("Safely ignored debug capture failure:", captureErr.message);
    }
    // ------------------------------------------------

    console.log("Incoming Payload:", JSON.stringify(body).substring(0, 500));

    // --- META WHATSAPP NAMESPACE ISOLATION & EVENT PROCESSING ---
    if (body?.object === 'whatsapp_business_account') {
      try {
        if (supabase) {
          const entry = body.entry?.[0];
          const changes = entry?.changes?.[0];
          const value = changes?.value;
          
          if (value?.messages && value.messages.length > 0) {
            // INBOUND MESSAGE
            const contact = value.contacts?.[0];
            const message = value.messages[0];
            
            let phone = contact?.wa_id || message.from;
            if (phone && phone.startsWith('+')) phone = phone.substring(1);
            const customerName = contact?.profile?.name || null;
            const wamid = message.id;
            const type = message.type;
            
            let textBody = null;
            if (type === 'text') {
              textBody = message.text?.body;
            } else {
              textBody = `[Unsupported message type: ${type}]`;
            }
            
            if (phone && wamid) {
              const timestamp = message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString();
              
              // Find or create conversation
              const { data: existingConv } = await supabase.from('whatsapp_conversations').select('id').eq('phone_number', phone).single();
              
              let convId;
              if (existingConv) {
                convId = existingConv.id;
                await supabase.from('whatsapp_conversations').update({
                  last_inbound_timestamp: timestamp,
                  updated_at: new Date().toISOString(),
                  ...(customerName ? { customer_name: customerName } : {})
                }).eq('id', convId);
              } else {
                const { data: newConv } = await supabase.from('whatsapp_conversations').insert({
                  phone_number: phone,
                  customer_name: customerName,
                  last_inbound_timestamp: timestamp,
                  updated_at: new Date().toISOString()
                }).select().single();
                convId = newConv?.id;
              }
              
              if (convId) {
                // Insert message (ignoring duplicate wamid errors natively handled by Postgres UNIQUE constraint)
                const { error: msgErr } = await supabase.from('whatsapp_messages').insert({
                  conversation_id: convId,
                  wamid: wamid,
                  direction: 'inbound',
                  type: type,
                  body: textBody,
                  meta_timestamp: timestamp
                });
                if (msgErr && msgErr.code !== '23505') { // 23505 is Unique Violation
                  console.error("WhatsApp message insert error:", msgErr.message);
                }
              }
            }
          } else if (value?.statuses && value.statuses.length > 0) {
            // OUTBOUND STATUS CALLBACK
            const statusObj = value.statuses[0];
            const wamid = statusObj.id;
            const status = statusObj.status; // 'sent', 'delivered', 'read', 'failed'
            
            if (wamid && status) {
              const statusHierarchy = { 'pending': 0, 'processing': 1, 'sent': 2, 'delivered': 3, 'read': 4, 'failed': -1 };
              const newLevel = statusHierarchy[status] || 0;
              
              // 1. Process free-form conversations (whatsapp_messages)
              const { data: existingMsg } = await supabase.from('whatsapp_messages').select('status').eq('wamid', wamid).single();
              if (existingMsg) {
                const currentStatus = existingMsg.status || 'pending';
                const currentLevel = statusHierarchy[currentStatus] || 0;
                
                // Prevent out-of-order downgrade
                // A 'failed' status should only apply if the current level is below 'sent' (i.e. it actually failed to send)
                // If it was already sent, delivered, or read, a delayed failed callback must not downgrade it.
                if ((status === 'failed' && currentLevel < statusHierarchy['sent']) || (status !== 'failed' && newLevel > currentLevel)) {
                  await supabase.from('whatsapp_messages').update({ status: status }).eq('wamid', wamid);
                }
              }

              // 2. Process lifecycle events (whatsapp_lifecycle_events)
              const { data: existingLifecycle } = await supabase.from('whatsapp_lifecycle_events').select('status').eq('wamid', wamid).single();
              if (existingLifecycle) {
                const currentStatus = existingLifecycle.status || 'pending';
                const currentLevel = statusHierarchy[currentStatus] || 0;

                // Same monotonic protection
                if ((status === 'failed' && currentLevel < statusHierarchy['sent']) || (status !== 'failed' && newLevel > currentLevel)) {
                  await supabase.from('whatsapp_lifecycle_events').update({ 
                    status: status,
                    updated_at: new Date().toISOString()
                  }).eq('wamid', wamid);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error("WhatsApp webhook processing error:", err.message);
      }

      return res.status(200).json({
        success: true,
        ignored: true,
        source: 'whatsapp',
        processed: true
      });
    }
    // -------------------------------------------------------------

    // --- [تحسين جذري] استخراج البيانات متعدد المستويات (Multi-Level Extraction) ---

    // 1. تحديد المصادر المحتملة للبيانات
    const payload = body.payload || {};
    const transaction = payload.transaction || body.transaction || {};

    // ملاحظة: transaction هي المصدر الأوثق للحالة والمبلغ

    // 2. البحث عن Customer في كل مكان (الأولوية للداخل ثم الخارج)
    const customer = transaction.customer || payload.customer || body.customer || {};

    // 3. البحث عن Metadata في كل مكان
    const metadata = transaction.metadata || payload.metadata || body.metadata || {};

    // 4. البحث عن معلومات البطاقة (تحديث شامل لالتقاط last_digits)
    // أولاً: نحدد كائن payment_method إذا وجد (لأنه يحتوي على البطاقة غالباً)
    const pmObj = transaction.payment_method || payload.payment_method || body.payment_method || {};

    // ثانياً: نبحث عن كائن البطاقة card في كل الأماكن المحتملة
    const card = transaction.card || payload.card || body.card || metadata.card || pmObj.card || {};

    // ثالثاً: نستخرج الأرقام (YouCanPay تسميها last_digits أحياناً)
    const finalLast4 = sanitizeString(card.last4 || card.last_digits || metadata.last4 || null);

    // 5. البحث عن معلومات CashPlus
    const cashplus = transaction.cashplus || payload.cashplus || body.cashplus || {};

    // --- استخراج الحقول الآن (أكثر أماناً) ---

    // الاسم، الإيميل، الهاتف (نبحث في كائن customer أولاً، ثم الحقول المباشرة)
    const rawName = customer.name || body.clientName || body.name || 'Unknown';
    const rawEmail = customer.email || body.clientEmail || body.email || 'Unknown';
    const rawPhone = customer.phone || body.clientPhone || body.phone || 'Unknown';

    // معرف الطلب (Order ID)
    // هذا مهم: في الويب هوك يأتي غالباً في transaction.order_id
    const rawOrderId = transaction.order_id || metadata.orderId || body.orderId || payload.order_id || 'N/A';

    // --- معالجة الحالة والمبلغ (من transaction حصراً إذا وجدت) ---
    let statusRaw = transaction.status !== undefined ? transaction.status : (body.paymentStatus || body.status || 'pending');
    let finalStatus = String(statusRaw);

    if (statusRaw === 1 || statusRaw === '1' || statusRaw === 'paid') {
      finalStatus = 'paid';
    } else if (statusRaw === -1) {
      finalStatus = 'failed';
    }

    // معالجة المبلغ (تحويل من السنتيم إذا لزم الأمر)
    let rawAmount = transaction.amount || body.amount || body.productPrice || body.price || metadata.finalAmount || null;
    if (rawAmount && rawAmount > 10000) rawAmount = rawAmount / 100;

    // باقي التفاصيل من Metadata أو Body
    const rawProduct = metadata.productTitle || body.productTitle || '';
    const rawSku = metadata.sku || body.sku || 'N/A';
    const rawVariant = metadata.productVariant || body.productVariant || '';
    const rawAddress = metadata.clientAddress || body.clientAddress || 'غير محدد';
    const rawNote = metadata.note || body.note || null;
    const rawDeliveryNote = metadata.delivery_note || body.delivery_note || '';
    const rawLang = metadata.lang || body.currentLang || body.lang || 'ar';
    const rawIsExternal = metadata.is_external !== undefined ? metadata.is_external : (body.is_external !== undefined ? body.is_external : false);

    // --- بناء الكائن النهائي الموحد ---
    const normalizedData = {
      timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Casablanca' }),
      orderId: sanitizeString(rawOrderId),
      clientName: sanitizeString(rawName),
      clientEmail: sanitizeString(rawEmail),
      clientPhone: normalizePhone(rawPhone),

      // --- E-Commerce Fields ---
      productTitle: sanitizeString(rawProduct),
      productSku: sanitizeString(rawSku),
      productVariant: sanitizeString(rawVariant),
      clientAddress: sanitizeString(rawAddress),
      note: sanitizeString(rawNote),
      delivery_note: sanitizeString(rawDeliveryNote),
      is_external: Boolean(rawIsExternal),
      // -------------------------

      paymentMethod: (function () {
        const raw = String(pmObj.name || transaction.payment_method || body.payment_method || metadata.paymentMethod || 'cod').toLowerCase();
        if (raw.includes('cod') || raw.includes('cash')) return 'cod';
        if (raw.includes('card') || raw.includes('stripe') || raw.includes('cmi')) return 'card';
        if (raw.includes('cashplus')) return 'cashplus';
        return 'other';
      })(),
      cashplusCode: sanitizeString(cashplus.code || null),
      last4: finalLast4,

      amount: rawAmount,
      currency: transaction.currency || body.currency || "MAD",
      lang: rawLang,

      utm_source: sanitizeString(metadata.utm_source || body.utm_source || ''),
      utm_medium: sanitizeString(metadata.utm_medium || body.utm_medium || ''),
      utm_campaign: sanitizeString(metadata.utm_campaign || body.utm_campaign || ''),
      utm_term: sanitizeString(metadata.utm_term || body.utm_term || ''),
      utm_content: sanitizeString(metadata.utm_content || body.utm_content || ''),
      utm_id: sanitizeString(metadata.utm_id || body.utm_id || ''),

      paymentStatus: sanitizeString(finalStatus),
      transactionId: sanitizeString(transaction.id || body.transaction_id || body.id || 'N/A')
    };

    // --- سجل للتحقق (Debug) ---
    if (normalizedData.clientName === 'Unknown') {
      console.warn("STILL UNKNOWN DATA. Structure dump:", JSON.stringify({
        hasTransaction: !!payload.transaction,
        hasCustomerInTrans: !!transaction.customer,
        hasMetadataInTrans: !!transaction.metadata,
        hasCustomerInPayload: !!payload.customer,
        keysInTransaction: Object.keys(transaction)
      }));
    }

    // --- الترجمة ---
    const t = telegramTranslations[normalizedData.lang] || telegramTranslations['fr'];
    const dbResult = await writeToSupabase(normalizedData);

    if (dbResult.success && !dbResult.isDuplicate && dbResult.id) {
      // Append the db_id so processOrderLifecycle has the primary key
      normalizedData.id = dbResult.id;
      
      // Dispatch order_received ONLY for genuinely new pending orders.
      // (The dashboard will handle confirmed/delivered status changes)
      if (normalizedData.paymentStatus === 'pending') {
         await processOrderLifecycle(normalizedData, 'order_received');
      }
    }

    // --- إرسال Telegram ---
    const message = `
${t.title}
-----------------------------------
${t.product} ${sanitizeTelegramHTML(normalizedData.productTitle)}
${t.quantity} ${sanitizeTelegramHTML(normalizedData.productVariant)}
-----------------------------------
${t.name} ${sanitizeTelegramHTML(normalizedData.clientName)}
${t.phone} ${sanitizeTelegramHTML(normalizedData.clientPhone)}
${t.address} ${sanitizeTelegramHTML(normalizedData.clientAddress)}
${t.note} ${sanitizeTelegramHTML(normalizedData.delivery_note)}
-----------------------------------
${t.method} ${sanitizeTelegramHTML(normalizedData.paymentMethod)}
${t.amount} ${sanitizeTelegramHTML(normalizedData.amount)} ${normalizedData.currency}
${t.req_id} ${sanitizeTelegramHTML(normalizedData.orderId)}
${t.status} ${sanitizeTelegramHTML(normalizedData.paymentStatus)}
    `;

    try {
      // [تحديث] إرسال للجميع
      const sendPromises = TELEGRAM_CHAT_IDS.map(chatId =>
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' })
          .catch(e => console.error(`Failed to send to ${chatId}:`, e.message))
      );
      await Promise.allSettled(sendPromises);
    } catch (botError) {
      console.error("Telegram Error:", botError.message);
    }

    res.status(200).json({ result: 'success', message: 'Notification processed.' });

  } catch (error) {
    console.error("Handler Error:", error.message);
    res.status(400).json({ error: "Bad Request", message: error.message });
  }
};
