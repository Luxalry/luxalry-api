// Shared utility functions for API validation and sanitization (Customized for E-commerce)
import crypto from 'crypto';

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

export function handleAdminCors(req, res) {
  const origin = req.headers.origin;
  const rawAllowedOrigins = process.env.ADMIN_ALLOWED_ORIGINS || '';
  
  // Parse and normalize allowed origins (trim whitespace, remove trailing slashes)
  const allowedOrigins = rawAllowedOrigins.split(',').map(o => o.trim().replace(/\/$/, ''));
  const normalizedOrigin = origin ? origin.replace(/\/$/, '') : null;
  
  if (normalizedOrigin && allowedOrigins.includes(normalizedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', origin); // Always reflect the exact incoming origin
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    // Explicitly reject untrusted origins. Do not set * when using credentials.
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, X-CSRF-Token');
  
  // If it's an OPTIONS request, return true so the caller can end the response
  return req.method === 'OPTIONS';
}

/**
 * Centralized IP Extraction (Canonical Normalization)
 * Resolves the true client IP consistently across issuance and verification,
 * stripping fluctuating infrastructure proxy chains (e.g., Vercel, Cloudflare).
 *
 * Precedence:
 * 1. x-forwarded-for (First IP in comma-separated list)
 * 2. x-real-ip
 * 3. req.socket.remoteAddress
 */
export function getCanonicalIP(req) {
  if (!req) return 'Unknown';
  
  // 1. x-forwarded-for (Proxy chain)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor && typeof forwardedFor === 'string') {
    // Vercel / Cloudflare append IPs to this list. The FIRST IP is the original client.
    const ips = forwardedFor.split(',');
    if (ips.length > 0) {
      const firstIp = ips[0].trim();
      if (firstIp) return firstIp;
    }
  }

  // 2. x-real-ip (Single proxy IP fallback)
  const realIp = req.headers['x-real-ip'];
  if (realIp && typeof realIp === 'string') {
    return realIp.trim();
  }

  // 3. Raw socket address (Fallback for direct connections / local dev)
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress.trim();
  }

  if (req.connection && req.connection.remoteAddress) {
    return req.connection.remoteAddress.trim();
  }

  return 'Unknown';
}

/**
 * [NEW] Centralized Escalation Token Validation
 */
export function validateEscalationToken(token, secret, req) {
    if (!token || !token.includes('.')) return null;
    
    try {
        const [payloadB64, signature] = token.split('.');
        
        // 1. Verify Signature
        const expectedSig = crypto.createHmac('sha256', secret)
            .update(Buffer.from(payloadB64, 'base64').toString())
            .digest('hex');
            
        if (signature !== expectedSig) return null;
        
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
        
        // 2. Verify Expiration & Scope
        if (payload.scope !== 'admin:escalation' || payload.exp <= Date.now()) return null;
        
        // 3. Verify IP and User-Agent Binding
        const currentIP = getCanonicalIP(req);
        const currentUA = req.headers['user-agent'] || 'Unknown';
        
        if (process.env.ESCALATION_ACTIVE === 'false') return null;
        if (payload.ip && payload.ip !== currentIP) return null;
        if (payload.ua && payload.ua !== currentUA) return null;
        
        return payload; // Valid
    } catch (e) {
        return null;
    }
}
