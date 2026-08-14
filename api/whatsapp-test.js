import { sendWhatsAppConfirmation } from './whatsapp.js';

export default async function handler(req, res) {
  // 1. Require POST only
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { message: 'Method Not Allowed' } });
  }

  // 2. Authentication: Require Basic Auth matching ADMIN_USERNAME / ADMIN_PASSWORD
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    return res.status(401).json({ success: false, error: { message: 'Unauthorized: Missing or invalid Basic Auth header' } });
  }
  const creds = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  if (creds[0] !== process.env.ADMIN_USERNAME || creds[1] !== process.env.ADMIN_PASSWORD) {
    // Artificial delay to prevent brute force
    await new Promise(resolve => setTimeout(resolve, 2000));
    return res.status(401).json({ success: false, error: { message: 'Unauthorized: Invalid credentials' } });
  }

  // 3. Extract and validate recipient phone number
  const { testPhone } = req.body || {};
  if (!testPhone || !/^\+?\d{8,15}$/.test(testPhone)) {
    return res.status(400).json({ 
      success: false, 
      error: { message: 'A valid testPhone parameter is required in the POST body.' } 
    });
  }

  // 4. Construct controlled test payload matching exactly the existing template contract
  const controlledData = {
    clientPhone: testPhone,
    lang: 'fr', // Explicitly test the French fallback as observed in whatsapp.js
    clientName: 'Test Administrator',
    productTitle: 'System Diagnostic Test',
    amount: '0.00',
    currency: 'MAD'
  };

  // 5. Invoke the EXISTING send function and capture the real response
  try {
    const result = await sendWhatsAppConfirmation(controlledData);

    if (result && result.success) {
      return res.status(200).json({
        success: true,
        meta: result.meta
      });
    } else {
      return res.status(result?.status || 500).json({
        success: false,
        status: result?.status || 500,
        error: result?.error || { message: 'Unknown error occurred during send.' }
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      status: 500,
      error: { message: err.message }
    });
  }
}
