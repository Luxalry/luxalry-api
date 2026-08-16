import { createClient } from '@supabase/supabase-js';
import { sendWhatsAppTemplate } from './whatsapp.js';

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn("Order Lifecycle: Supabase URL or Key missing. Idempotency will fail.");
}

/**
 * Processes an order lifecycle event and sends a WhatsApp template if applicable.
 * Uses a unique constraint on `whatsapp_lifecycle_events` (order_id, event_type) to ensure idempotency.
 * 
 * @param {Object} order - The full order record from the database
 * @param {String} eventType - 'order_received', 'order_confirmation', 'order_delivered', 'order_cancelled'
 */
export async function processOrderLifecycle(order, eventType, isManualRetry = false) {
  if (!supabase) {
    console.error("Order Lifecycle: Supabase client not initialized.");
    return { success: false, error: "Supabase not initialized" };
  }

  // Identity rules
  const orderId = order.id; // immutable primary key
  if (!orderId || isNaN(Number(orderId))) {
    console.error(`Order Lifecycle: Invalid primary key for order ${order.order_id}`);
    return { success: false, error: "Invalid primary key" };
  }

  try {
    let eventId;
    let currentAttemptCount = 0;

    if (isManualRetry) {
      // Manual retry: find existing 'failed' record
      const { data: existingEvent, error: fetchErr } = await supabase
        .from('whatsapp_lifecycle_events')
        .select('*')
        .eq('order_id', orderId)
        .eq('event_type', eventType)
        .single();

      if (fetchErr || !existingEvent || existingEvent.status !== 'failed') {
        return { success: false, error: "Only failed events can be retried." };
      }
      eventId = existingEvent.id;
      currentAttemptCount = existingEvent.attempt_count || 0;
    } else {
      // 1. Attempt to create the idempotent event record (status = pending)
      const { data: eventRecord, error: insertError } = await supabase
        .from('whatsapp_lifecycle_events')
        .insert({
          order_id: orderId,
          event_type: eventType,
          status: 'pending',
          attempt_count: 0
        })
        .select('id')
        .single();

      if (insertError) {
        if (insertError.code === '23505') {
          // Unique constraint violation: The event was already processed for this order.
          console.log(`Order Lifecycle: Event '${eventType}' already exists for order id ${orderId}. Skipping.`);
          return { success: true, skipped: true, reason: 'Already processed' };
        }
        console.error(`Order Lifecycle: Failed to create event record for ${orderId}: ${insertError.message}`);
        return { success: false, error: insertError.message };
      }
      eventId = eventRecord.id;
      currentAttemptCount = 0;
    }

    // 2. Atomically transition to 'processing' before the external call
    // This is the crash-window safety boundary.
    const { error: processingErr } = await supabase
      .from('whatsapp_lifecycle_events')
      .update({
        status: 'processing',
        attempt_count: currentAttemptCount + 1,
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', eventId)
      // Safety check: ensure we only transition from pending or failed
      .in('status', ['pending', 'failed']);

    if (processingErr) {
       console.error(`Failed to acquire processing lock for event ${eventId}: ${processingErr.message}`);
       return { success: false, error: "Failed to transition to processing" };
    }

    // 2. Prepare the parameters based on the business model
    const customerName = order.full_name || order.clientName || 'Client';
    const businessOrderId = order.order_id || 'N/A';
    const product = order.product_name || order.productTitle || 'Produit';
    const amount = order.amount || 0;
    const currency = order.currency || 'MAD';
    
    // Language resolution mapping
    const lang = resolveLanguage(order.lang || order.language || 'fr');
    let localizedCustomerName = customerName;
    let localizedProduct = product;

    if (lang === 'ar') {
      if (customerName === 'Client') localizedCustomerName = 'العميل';
      if (product === 'Produit') localizedProduct = 'المنتج';
    }

    let components = [];

    if (eventType === 'order_received') {
      components = [
        { type: "text", text: localizedCustomerName },
        { type: "text", text: String(businessOrderId) },
        { type: "text", text: localizedProduct },
        { type: "text", text: `${amount} ${currency}` }
      ];
    } else if (eventType === 'order_confirmation') {
      const estimatedDelivery = process.env.ESTIMATED_DELIVERY_TIME || 
        (lang === 'ar' ? '24-48 ساعة' : (lang === 'en_US' ? '24-48 hours' : '24-48 heures'));
      
      components = [
        { type: "text", text: localizedCustomerName },
        { type: "text", text: String(businessOrderId) },
        { type: "text", text: localizedProduct },
        { type: "text", text: estimatedDelivery }
      ];
    } else if (eventType === 'order_delivered') {
      components = [
        { type: "text", text: localizedCustomerName },
        { type: "text", text: String(businessOrderId) },
        { type: "text", text: localizedProduct }
      ];
    } else if (eventType === 'order_cancelled') {
      components = [
        { type: "text", text: localizedCustomerName },
        { type: "text", text: String(businessOrderId) },
        { type: "text", text: localizedProduct }
      ];
    } else {
      console.error(`Order Lifecycle: Unsupported eventType '${eventType}'`);
      await updateEventStatus(eventId, 'failed', null, `Unsupported eventType ${eventType}`);
      return { success: false, error: "Unsupported event type" };
    }

    // 3. Dispatch to WhatsApp
    const phone = order.phone || order.clientPhone;
    
    // Attempt send
    const waResult = await sendWhatsAppTemplate(phone, eventType, lang, components);

    // 4. Update the event record state
    if (waResult.success) {
      await updateEventStatus(eventId, 'sent', waResult.wamid || 'unknown_wamid', null);
      return { success: true, wamid: waResult.wamid };
    } else {
      const errorMsg = waResult.error?.message || JSON.stringify(waResult.error);
      await updateEventStatus(eventId, 'failed', null, errorMsg);
      return { success: false, error: errorMsg };
    }

  } catch (error) {
    console.error(`Order Lifecycle Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function updateEventStatus(eventId, status, wamid, errorDetails) {
  try {
    const updates = { status, updated_at: new Date().toISOString() };
    if (wamid) updates.wamid = wamid;
    if (errorDetails) updates.error_details = errorDetails;

    await supabase
      .from('whatsapp_lifecycle_events')
      .update(updates)
      .eq('id', eventId);
  } catch (err) {
    console.error(`Order Lifecycle: Failed to update event status for event ${eventId}: ${err.message}`);
  }
}

function resolveLanguage(lang) {
  if (!lang) return 'fr';
  const l = lang.toLowerCase().trim();
  if (l === 'ar') return 'ar';
  if (l === 'fr') return 'fr';
  if (l === 'en' || l === 'en-us' || l === 'en_us') return 'en_US';
  return 'fr'; // fallback
}
