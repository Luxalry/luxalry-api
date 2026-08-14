// ملف whatsapp.js لإدارة رسائل WhatsApp API (Meta)

/**
 * دليل إنشاء القوالب في منصة Meta:
 * ستحتاج لإنشاء قالب واحد باسم `order_confirmation` يحتوي على ثلاث لغات (العربية، الفرنسية، الإنجليزية).
 * 
 * القالب (العربية - ar):
 * مرحباً {{1}}،
 * تم تأكيد طلبك لمنتج {{2}} بنجاح بقيمة {{3}}. سنتواصل معك قريباً لتأكيد موعد التوصيل.
 * 
 * القالب (الفرنسية - fr):
 * Bonjour {{1}},
 * Votre commande pour le produit {{2}} d'un montant de {{3}} a été confirmée avec succès. Nous vous contacterons bientôt pour la livraison.
 * 
 * القالب (الإنجليزية - en_US):
 * Hello {{1}},
 * Your order for {{2}} amounting to {{3}} has been confirmed successfully. We will contact you soon for delivery.
 */

function resolveWhatsAppLanguage(lang) {
  if (!lang) return 'fr';
  const l = lang.toLowerCase().trim();
  if (l === 'ar') return 'ar';
  if (l === 'fr') return 'fr';
  if (l === 'en' || l === 'en-us' || l === 'en_us') return 'en_US';
  return 'fr'; // fallback
}

// إعدادات WhatsApp API (Meta)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// أسماء القوالب بناءً على اللغة (إذا كنت تفضل استخدام قوالب منفصلة لكل لغة بدلاً من قالب واحد متعدد اللغات)
// أو استخدام اسم قالب واحد مع تحديد رمز اللغة في الـ Payload
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'order_confirmation';

export async function sendWhatsAppConfirmation(data) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("Skipping WhatsApp: Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_ID.");
    return { success: false, error: { message: "Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_ID in environment" } };
  }

  try {
    let phone = data.clientPhone;
    if (phone && phone.startsWith('+')) {
      phone = phone.substring(1); // إزالة الـ + لأن API يفضل الرقم بدونها
    }

    if (!phone || phone === 'Unknown') {
      console.warn("Skipping WhatsApp: Invalid phone number.");
      return { success: false, error: { message: "Invalid phone number" } };
    }

    // تحديد لغة العميل
    const langCode = resolveWhatsAppLanguage(data.lang);

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: TEMPLATE_NAME, // اسم القالب الموحد في Meta
        language: {
          code: langCode     // Meta ستستخدم النسخة المناسبة (ar, fr, en) من القالب
        },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: data.clientName || (langCode === 'ar' ? 'العميل' : 'Client') },
              { type: "text", text: data.productTitle || (langCode === 'ar' ? 'المنتج' : 'Produit') },
              { type: "text", text: `${data.amount || 0} ${data.currency || 'MAD'}` }
            ]
          }
        ]
      }
    };

    const response = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok) {
      console.error(`Meta API Error: ${result.error?.message || JSON.stringify(result)}`);
      return { success: false, status: response.status, error: result.error || result };
    }
    
    // إخفاء جزء من رقم الهاتف في السجلات للحماية
    const maskedPhone = phone.length >= 8 ? phone.substring(0, 4) + '***' + phone.slice(-2) : '***';
    console.log(`WhatsApp confirmation sent to ${maskedPhone} (Template: ${TEMPLATE_NAME}, Lang: ${langCode})`);
    
    return { success: true, meta: result };
  } catch (error) {
    console.error("WhatsApp Sending Error:", error.message);
    return { success: false, status: 500, error: { message: error.message } };
  }
}
