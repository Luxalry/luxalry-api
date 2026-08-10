// إعدادات WhatsApp API (Meta)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// أسماء القوالب بناءً على اللغة (إذا كنت تفضل استخدام قوالب منفصلة لكل لغة بدلاً من قالب واحد متعدد اللغات)
// أو استخدام اسم قالب واحد مع تحديد رمز اللغة في الـ Payload
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'order_confirmation';

export async function sendWhatsAppConfirmation(data) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("Skipping WhatsApp: Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_ID.");
    return;
  }

  try {
    let phone = data.clientPhone;
    if (phone && phone.startsWith('+')) {
      phone = phone.substring(1); // إزالة الـ + لأن API يفضل الرقم بدونها
    }

    if (!phone || phone === 'Unknown') {
      console.warn("Skipping WhatsApp: Invalid phone number.");
      return;
    }

    // تحديد لغة العميل
    const langCode = data.lang === 'ar' ? 'ar' : (data.lang === 'en' ? 'en' : 'fr');

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

    const response = await fetch(`https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(JSON.stringify(result));
    }
    console.log(`WhatsApp confirmation sent to ${phone} (Lang: ${langCode})`);
  } catch (error) {
    console.error("WhatsApp Sending Error:", error.message);
  }
}
