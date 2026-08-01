import TelegramBot from 'node-telegram-bot-api';
import { JWT } from 'google-auth-library';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { validateEmail, normalizePhone, sanitizeString, sanitizeTelegramHTML } from './utils.js';
import crypto from 'crypto';
import SibApiV3Sdk from 'sib-api-v3-sdk'; // [إضافة] مكتبة البريد
import { emailTemplates } from './email-templates.js';

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
    const { error } = await supabase.from('leads').upsert({
      order_id: data.orderId,
      full_name: data.clientName,
      email: data.clientEmail,
      phone: data.clientPhone,

      // --- E-commerce Fields ---
      product_name: data.productTitle,
      quantity: data.productVariant,
      address: data.clientAddress,
      delivery_note: data.delivery_note,
      // -------------------------

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
    }, { onConflict: 'order_id' });
    if (error) throw error;
    console.log("Successfully saved to Supabase");
    return true;
  } catch (e) {
    console.error("Supabase Write Error:", e.message);
    return false;
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
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// [تحديث] دعم عدة مستلمين مفصولين بفاصلة
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim()).filter(Boolean);
const YOUCAN_PRIVATE_KEY = process.env.YOUCAN_PRIVATE_KEY;

// إعدادات البريد (Brevo)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_SENDER_ADDRESS = process.env.EMAIL_SENDER_ADDRESS;
const EMAIL_SENDER_NAME = "Luxalry";

// التحقق من المتغيرات البيئية
if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY ||
  !TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
  console.error('CRITICAL: Missing required environment variables for notify service');
}

// 2. تهيئة Google Sheet
let doc;

// ترجمة الرسائل (Telegram)
const telegramTranslations = {
  ar: {
    title: "🔥 <b>طلب جديد (Dermossence)</b> 📦",
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
    title: "🔥 <b>Nouvelle Commande (Dermossence)</b> 📦",
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
    title: "🔥 <b>New Order (Dermossence)</b> 📦",
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
const emailConfirmationTemplates = emailTemplates.payment_confirmation;

// دالة مصادقة Google Sheets
async function authGoogleSheets() {
  try {
    const serviceAccountAuth = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
  } catch (e) {
    console.error("Google Sheets Auth Error:", e.message);
  }
}

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

export default async (req, res) => {
  // CORS Setup
  const allowedOrigins = [
    'https://dermossence.luxalry.shop',
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

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
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

    console.log("Incoming Payload:", JSON.stringify(body).substring(0, 500));

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
    let rawAmount = transaction.amount || body.amount || metadata.finalAmount || null;
    if (rawAmount && rawAmount > 10000) rawAmount = rawAmount / 100;

    // باقي التفاصيل من Metadata أو Body
    const rawProduct = metadata.productTitle || body.productTitle || 'Dermossence';
    const rawVariant = metadata.productVariant || body.productVariant || '1';
    const rawAddress = metadata.clientAddress || body.clientAddress || 'غير محدد';
    const rawNote = metadata.delivery_note || body.delivery_note || body.note || 'لا توجد ملاحظات';
    const rawLang = metadata.lang || body.currentLang || body.lang || 'ar';

    // --- بناء الكائن النهائي الموحد ---
    const normalizedData = {
      timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Casablanca' }),
      orderId: sanitizeString(rawOrderId),
      clientName: sanitizeString(rawName),
      clientEmail: sanitizeString(rawEmail),
      clientPhone: normalizePhone(rawPhone),

      // --- E-Commerce Fields ---
      productTitle: sanitizeString(rawProduct),
      productVariant: sanitizeString(rawVariant),
      clientAddress: sanitizeString(rawAddress),
      delivery_note: sanitizeString(rawNote),
      // -------------------------

      paymentMethod: sanitizeString(pmObj.name || transaction.payment_method || body.payment_method || metadata.paymentMethod || 'COD'),
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

    // --- الحفظ المزدوج (Dual Write: Google Sheets + Supabase) ---
    const sheetPromise = (async () => {
      try {
        await authGoogleSheets();
        if (doc) {
          let sheet = doc.sheetsByTitle["Leads"];
          if (!sheet) sheet = await doc.addSheet({ title: "Leads" });
          // ... (Load headers logic if needed, skipped for brevity as sheet usually exists)
          await sheet.addRow({
            "Timestamp": normalizedData.timestamp,
            "Order ID": normalizedData.orderId,
            "Full Name": normalizedData.clientName,
            "Email": normalizedData.clientEmail,
            "Phone Number": normalizedData.clientPhone,

            // --- E-Commerce Columns ---
            "Product": normalizedData.productTitle,
            "Quantity": normalizedData.productVariant,
            "Address": normalizedData.clientAddress,
            "Delivery Note": normalizedData.delivery_note,
            // --------------------------

            "Payment Method": normalizedData.paymentMethod,
            "CashPlus Code": normalizedData.cashplusCode,
            "Last4Digits": normalizedData.last4,
            "Amount": normalizedData.amount,
            "Currency": normalizedData.currency,
            "Lang": normalizedData.lang,
            "utm_source": normalizedData.utm_source,
            "utm_medium": normalizedData.utm_medium,
            "utm_campaign": normalizedData.utm_campaign,
            "utm_term": normalizedData.utm_term,
            "utm_content": normalizedData.utm_content,
            "utm_id": normalizedData.utm_id,
            "Payment Status": normalizedData.paymentStatus,
            "Transaction ID": normalizedData.transactionId,
            "Last Updated": new Date().toISOString(),
            "Last Updated By": "System"
          });
          console.log("Successfully saved to Google Sheets");
          return true;
        }
      } catch (e) {
        console.error("Sheet Error:", e.message);
        throw e;
      }
    })();

    const dbPromise = writeToSupabase(normalizedData);

    // ننتظر انتهاء العمليتين (لا نوقف التنفيذ إذا فشلت إحداهما)
    await Promise.allSettled([sheetPromise, dbPromise]);

    // --- إرسال Telegram ---
    const message = `
${t.title}
-----------------------------------
${t.product} ${sanitizeTelegramHTML(normalizedData.productTitle)}
${t.quantity} ${sanitizeTelegramHTML(normalizedData.productVariant)} عبوة
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

    // --- [إضافة جديدة] إرسال بريد تأكيد الدفع ---
    if (normalizedData.paymentStatus === 'paid' && normalizedData.clientEmail && normalizedData.clientEmail !== 'Unknown') {
      await sendConfirmationEmail(normalizedData);
    }

    res.status(200).json({ result: 'success', message: 'Notification processed.' });

  } catch (error) {
    console.error("Handler Error:", error.message);
    res.status(400).json({ error: "Bad Request", message: error.message });
  }
};
