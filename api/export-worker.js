import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Format date to readable string
function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB');
}

export default async function handler(req, res) {
  // 1. Security Check (Vercel Cron Secret)
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Allow manual invocation in dev/testing via secret query param
  if (!process.env.CRON_SECRET && req.query.secret !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
      // In production without CRON_SECRET, fallback to query secret
      if (req.query.secret !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
  }

  try {
    // 2. Explicit Stale PROCESSING Recovery
    // Recovers any order stuck in PROCESSING for more than 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60000).toISOString();
    
    await supabase
      .from('leads')
      .update({ 
        export_status: 'FAILED', 
        export_last_error: 'Worker timeout recovery'
      })
      .eq('export_status', 'PROCESSING')
      .lt('last_updated', tenMinutesAgo);

    // 3. Atomic Claim of Eligible Orders
    // Requires migration_atomic_claim.sql to be executed manually in Supabase
    const { data: claimedOrders, error: claimError } = await supabase.rpc('claim_pending_exports', {
      batch_size: 50
    });

    if (claimError) throw claimError;
    if (!claimedOrders || claimedOrders.length === 0) {
      return res.status(200).json({ message: 'No eligible pending external orders found.' });
    }

    // 4. Format the exact 9-column Google Sheets Contract
    const sheetRows = claimedOrders.map(order => ({
      'date_order': formatDate(order.created_at),
      'full_name': order.full_name || '',
      'phone': order.phone || '',
      'address': order.address || '',
      'sku': order.product_sku || '',
      'qte': order.quantity || '',
      'price': order.amount || '',
      'note': order.note || '',
      'delivery_note': order.delivery_note || ''
    }));

    // 5. Connect to Google Sheets & Export
    try {
      const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
      await doc.loadInfo();

      let sheet = doc.sheetsByTitle["Sheet1"];
      if (!sheet) {
          // Robustness: create it if it doesn't exist to prevent crash, though it should exist
          sheet = await doc.addSheet({ 
              title: "Sheet1", 
              headerValues: ['date_order', 'full_name', 'phone', 'address', 'sku', 'qte', 'price', 'note', 'delivery_note'] 
          });
      }

      // Bulk Append
      await sheet.addRows(sheetRows);

      // 6. Mark Success
      const successfulIds = claimedOrders.map(o => o.id);
      await supabase
        .from('leads')
        .update({
          export_status: 'EXPORTED',
          exported_at: new Date().toISOString(),
          export_last_error: null
        })
        .in('id', successfulIds);

      return res.status(200).json({ message: `Successfully exported ${successfulIds.length} orders.` });

    } catch (sheetError) {
      // 7. Mark Failure
      console.error('Google Sheets Export Failed:', sheetError.message);
      
      // We must increment export_attempts and set FAILED for the entire batch
      // Supabase JS doesn't support bulk updates with arithmetic (export_attempts + 1) easily in one query without RPC
      // So we will do it individually or with a fallback
      for (const order of claimedOrders) {
        await supabase
          .from('leads')
          .update({
            export_status: 'FAILED',
            export_attempts: order.export_attempts + 1,
            export_last_error: sheetError.message.substring(0, 500)
          })
          .eq('id', order.id);
      }

      return res.status(500).json({ error: 'Export failed, batch reverted for retry', details: sheetError.message });
    }

  } catch (err) {
    console.error('Export Worker Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
