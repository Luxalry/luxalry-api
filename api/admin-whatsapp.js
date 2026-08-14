import { createClient } from '@supabase/supabase-js';
import { sendWhatsAppText } from './whatsapp.js';
import { verifyAdmin } from './access.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Helper to extract authentication
function getAuthCredentials(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const base64 = authHeader.split(' ')[1];
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const [username, password] = decoded.split(':');
    return { username, password };
  } catch (e) {
    return null;
  }
}

export default async (req, res) => {
  // CORS setup
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Authenticate Admin
    const creds = getAuthCredentials(req);
    if (!creds || !verifyAdmin(creds.username, creds.password)) {
      return res.status(401).json({ error: 'Unauthorized access' });
    }

    const { action } = req.query;

    if (req.method === 'GET') {
      if (action === 'conversations') {
        // Fetch list of conversations
        const { data, error } = await supabase
          .from('whatsapp_conversations')
          .select('*')
          .order('updated_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json({ success: true, conversations: data });
      } 
      else if (action === 'messages') {
        const { conversationId } = req.query;
        if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });

        const { data, error } = await supabase
          .from('whatsapp_messages')
          .select('*')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true });

        if (error) throw error;
        return res.status(200).json({ success: true, messages: data });
      }
    } 
    else if (req.method === 'POST') {
      if (action === 'send') {
        const { conversationId, text } = req.body;
        
        if (!conversationId || !text || text.trim() === '') {
          return res.status(400).json({ success: false, error: 'Missing conversationId or text' });
        }

        // 1. Validate 24-hour window
        const { data: conv, error: convErr } = await supabase
          .from('whatsapp_conversations')
          .select('id, phone_number, last_inbound_timestamp')
          .eq('id', conversationId)
          .single();

        if (convErr || !conv) {
          return res.status(404).json({ success: false, error: 'Conversation not found' });
        }

        if (!conv.last_inbound_timestamp) {
          return res.status(403).json({ 
            success: false, 
            error: 'FREE_FORM_WINDOW_EXPIRED', 
            message: 'A template message is required for this customer. (No inbound message on record)' 
          });
        }

        const lastInboundTime = new Date(conv.last_inbound_timestamp).getTime();
        const now = Date.now();
        const hours24 = 24 * 60 * 60 * 1000;

        if (now - lastInboundTime > hours24) {
          return res.status(403).json({ 
            success: false, 
            error: 'FREE_FORM_WINDOW_EXPIRED', 
            message: 'A template message is required for this customer. The 24-hour window has expired.' 
          });
        }

        // 2. Call Meta API
        const sendResult = await sendWhatsAppText(conv.phone_number, text);
        
        if (!sendResult.success) {
          // If Meta rejects, return structured failure
          return res.status(400).json({ 
            success: false, 
            error: 'META_API_ERROR', 
            details: sendResult.error 
          });
        }

        const wamid = sendResult.wamid;

        // 3. Persist outbound message
        const { error: insertErr } = await supabase
          .from('whatsapp_messages')
          .insert({
            conversation_id: conv.id,
            wamid: wamid,
            direction: 'outbound',
            type: 'text',
            body: text.trim(),
            status: 'sent', // Initial status
            meta_timestamp: new Date().toISOString()
          });

        if (insertErr) {
          console.error("Error persisting outbound message:", insertErr.message);
          // Message was sent, but DB insert failed. 
          // We return success to admin but log the DB error. 
          // Status updates will fail to find wamid later.
        }

        // Update conversation updated_at
        await supabase
          .from('whatsapp_conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conv.id);

        return res.status(200).json({ success: true, wamid: wamid });
      }
    }

    return res.status(404).json({ error: 'Action not found' });
  } catch (error) {
    console.error("Admin WhatsApp API Error:", error.message);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};
