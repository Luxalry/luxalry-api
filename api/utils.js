// Shared utility functions for API validation and sanitization (Customized for E-commerce)

export function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function validatePhone(phone) {
  // Moroccan phone validation (simplified)
  const phoneRegex = /^(\+212|00212|212|0)?[6-7]\d{8}$/;
  return phoneRegex.test(phone.replace(/[\s\-]/g, ''));
}

export function sanitizeString(str) {
  return str ? str.toString().trim().replace(/[<>\"'&]/g, '') : '';
}

export function validateRequired(data, fields) {
  const missing = fields.filter(field => !data[field] || data[field].toString().trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
}

export function normalizePhone(phone) {
  if (!phone) return null;

  // حذف المسافات و الرموز
  phone = phone.replace(/[\s\-]/g, '');

  // 1) إذا بدى بـ +212 => خليه كما هو ولكن صححو
  if (phone.startsWith('+212')) {
    return '+212' + phone.slice(4); // نتأكد مزال فيه 6XXXXXXXX
  }

  // 2) إذا بدى بـ 00212 => حولو لـ +212
  if (phone.startsWith('00212')) {
    return '+212' + phone.slice(5);
  }

  // 3) إذا بدى بـ 212 (بلا +) => حولو لـ +212
  if (phone.startsWith('212')) {
    return '+212' + phone.slice(3);
  }

  // 4) إذا بدى بـ 0 => حذف 0 وإضافة +212
  if (phone.startsWith('0')) {
    return '+212' + phone.slice(1);
  }

  // 5) إذا بدى بـ 6 مباشرة => ضيف +212
  if (phone.startsWith('6') || phone.startsWith('7')) {
    return '+212' + phone;
  }

  // fallback
  return phone;
}

export function sanitizeTelegramHTML(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
