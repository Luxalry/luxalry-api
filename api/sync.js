import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';

// --- Configuration ---
let supabase;
try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    } else {
        console.warn('Supabase credentials missing in sync.js');
    }
} catch (e) {
    console.error('Supabase init error in sync.js:', e);
}

// --- Google Sheets Connection ---
async function getGoogleSheet(sheetTitle) {
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    // Auto-create sheet if missing (Robustness)
    if (!doc.sheetsByTitle[sheetTitle]) {
        let headers = [];
        if (sheetTitle === 'Leads') headers = ['Timestamp', 'Order ID', 'Full Name', 'Email', 'Phone Number', 'Product', 'Quantity', 'Address', 'Delivery Note', 'Payment Status', 'Payment Method', 'Transaction ID', 'CashPlus Code', 'Last4Digits', 'Amount', 'Currency', 'Lang', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'Last Updated', 'Last Updated By']; if (sheetTitle === 'Marketing_Spend') headers = ['Spend ID', 'Date', 'Campaign', 'Source', 'utm_id', 'Ad Spend', 'Impressions', 'Clicks', 'Last Updated', 'Last Updated By'];
        if (sheetTitle === 'Campaign_Registry') headers = ['Campaign Name', 'Budget', 'Start DateTime', 'End DateTime', 'Status', 'Last Updated', 'Last Updated By', 'utm_id'];

        if (headers.length > 0) {
            await doc.addSheet({ title: sheetTitle, headerValues: headers });
        }
    }

    return doc.sheetsByTitle[sheetTitle];
}

// --- Helper: Parse Dates Robustly ---
function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return val;
    // Handle Google Sheets custom format "YYYY-MM-DD HH h MM min SS s"
    let clean = String(val).replace(' h ', ':').replace(' min ', ':').replace(' s', '');
    const d = new Date(clean);
    return isNaN(d.getTime()) ? null : d;
}

// --- Main Handler ---
export default async function handler(req, res) {
    // CORS
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // Security
    const authHeader = req.headers.authorization || '';
    if (!authHeader && !req.query.secret) return res.status(401).json({ error: 'Unauthorized' });

    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

    const { target = 'leads' } = req.query;

    try {
        let result;
        if (target === 'leads') result = await syncLeads();
        else if (target === 'marketing_spend') result = await syncMarketingSpend();
        else if (target === 'campaigns') result = await syncCampaigns();
        else return res.status(400).json({ error: 'Invalid target' });

        return res.status(200).json(result);
    } catch (e) {
        console.error('Sync Error:', e);
        return res.status(500).json({ error: e.message });
    }
}

// ==============================================================================
// 1. SYNC LEADS (Bidirectional)
// ==============================================================================
async function syncLeads() {
    const sheet = await getGoogleSheet('Leads');
    const rows = await sheet.getRows();

    // Fetch DB Data
    const { data: dbRows, error } = await supabase.from('leads').select('*');
    if (error) throw error;

    const stats = { to_sheet: 0, to_db: 0, updates_to_sheet: 0, updates_to_db: 0 };

    // Maps for O(1) lookup
    const dbMap = new Map(dbRows.map(r => [r.order_id, r]));
    const sheetMap = new Map(rows.map(r => [r.get('Order ID'), r]));

    // --- A. Process Sheet Rows (Source of Truth 1) ---
    for (const row of rows) {
        const id = row.get('Order ID');
        if (!id) continue;

        const dbItem = dbMap.get(id);

        if (!dbItem) {
            // Case 1: Exists in Sheet, Missing in DB -> Insert to DB
            await insertLeadToDB(row);
            stats.to_db++;
        } else {
            // Case 2: Exists in Both -> Conflict Resolution
            const sheetTime = parseDate(row.get('Last Updated')) || parseDate(row.get('Timestamp')) || new Date(0);
            const dbTime = parseDate(dbItem.last_updated) || parseDate(dbItem.created_at) || new Date(0);

            const sheetUser = row.get('Last Updated By');
            const dbUser = dbItem.last_updated_by;

            // --- Legacy Data Recovery Logic ---
            // If Sheet has a user but DB doesn't, we ALWAYS trust Sheet (backfill).
            if (sheetUser && !dbUser) {
                await updateLeadInDB(row);
                stats.updates_to_db++;
            }
            else if (sheetTime > dbTime) {
                // Sheet is newer -> Update DB
                await updateLeadInDB(row);
                stats.updates_to_db++;
            } else if (dbTime > sheetTime) {
                // DB is newer -> Update Sheet
                updateLeadInSheet(row, dbItem);
                await row.save();
                stats.updates_to_sheet++;
            }
        }
    }

    // --- B. Process DB Rows (Source of Truth 2) ---
    for (const dbItem of dbRows) {
        if (!sheetMap.has(dbItem.order_id)) {
            // Case 3: Exists in DB, Missing in Sheet -> Insert to Sheet
            await insertLeadToSheet(sheet, dbItem);
            stats.to_sheet++;
        }
    }

    return { status: 'success', stats };
}

// --- Lead Helpers ---
async function insertLeadToDB(row) {
    let createdAt = parseDate(row.get('Timestamp')) || new Date();
    await supabase.from('leads').insert({
        order_id: row.get('Order ID'),
        full_name: row.get('Full Name'),
        email: row.get('Email'),
        phone: row.get('Phone Number'),
        product_name: row.get('Product'),
        quantity: row.get('Quantity'),
        address: row.get('Address'),
        delivery_note: row.get('Delivery Note'),
        status: row.get('Payment Status'),
        amount: row.get('Amount'),
        payment_method: row.get('Payment Method'),
        transaction_id: row.get('Transaction ID'),
        cashplus_code: row.get('CashPlus Code'),
        last4_digits: row.get('Last4Digits'),
        lang: row.get('Lang'),
        utm_source: row.get('utm_source'),
        utm_medium: row.get('utm_medium'),
        utm_campaign: row.get('utm_campaign'),
        utm_term: row.get('utm_term'),
        utm_content: row.get('utm_content'),
        utm_id: row.get('utm_id'), // [NEW]
        created_at: createdAt,
        last_updated: parseDate(row.get('Last Updated')) || createdAt,
        last_updated_by: row.get('Last Updated By')
    });
}

async function updateLeadInDB(row) {
    await supabase.from('leads').update({
        full_name: row.get('Full Name'),
        email: row.get('Email'),
        phone: row.get('Phone Number'),
        product_name: row.get('Product'),
        quantity: row.get('Quantity'),
        address: row.get('Address'),
        delivery_note: row.get('Delivery Note'),
        status: row.get('Payment Status'),
        amount: row.get('Amount'),
        payment_method: row.get('Payment Method'),
        transaction_id: row.get('Transaction ID'),
        cashplus_code: row.get('CashPlus Code'),
        last4_digits: row.get('Last4Digits'),
        lang: row.get('Lang'),
        utm_source: row.get('utm_source'),
        utm_medium: row.get('utm_medium'),
        utm_campaign: row.get('utm_campaign'),
        utm_term: row.get('utm_term'),
        utm_content: row.get('utm_content'),
        utm_id: row.get('utm_id'), // [NEW]
        last_updated: parseDate(row.get('Last Updated')) || new Date(),
        last_updated_by: row.get('Last Updated By')
    }).eq('order_id', row.get('Order ID'));
}

async function insertLeadToSheet(sheet, dbItem) {
    await sheet.addRow({
        'Timestamp': dbItem.created_at,
        'Order ID': dbItem.order_id,
        'Full Name': dbItem.full_name,
        'Email': dbItem.email,
        'Phone Number': dbItem.phone,
        'Product': dbItem.product_name || 'Dermossence',
        'Quantity': dbItem.quantity || '1',
        'Address': dbItem.address || '',
        'Delivery Note': dbItem.delivery_note || '',
        'Payment Status': dbItem.status,
        'Payment Method': dbItem.payment_method,
        'Transaction ID': dbItem.transaction_id,
        'CashPlus Code': dbItem.cashplus_code,
        'Last4Digits': dbItem.last4_digits,
        'Amount': dbItem.amount,
        'Currency': dbItem.currency || 'MAD',
        'Lang': dbItem.lang,
        'utm_source': dbItem.utm_source,
        'utm_medium': dbItem.utm_medium,
        'utm_campaign': dbItem.utm_campaign,
        'utm_term': dbItem.utm_term,
        'utm_content': dbItem.utm_content,
        'utm_id': dbItem.utm_id, // [NEW]
        'Last Updated': dbItem.last_updated,
        'Last Updated By': dbItem.last_updated_by
    });
}

function updateLeadInSheet(row, dbItem) {
    row.assign({
        'Full Name': dbItem.full_name,
        'Email': dbItem.email,
        'Phone Number': dbItem.phone,
        'Product': dbItem.product_name || 'Dermossence',
        'Quantity': dbItem.quantity || '1',
        'Address': dbItem.address || '',
        'Delivery Note': dbItem.delivery_note || '',
        'Payment Status': dbItem.status,
        'Payment Method': dbItem.payment_method,
        'Transaction ID': dbItem.transaction_id,
        'CashPlus Code': dbItem.cashplus_code,
        'Last4Digits': dbItem.last4_digits,
        'Amount': dbItem.amount,
        'Lang': dbItem.lang,
        'utm_source': dbItem.utm_source,
        'utm_medium': dbItem.utm_medium,
        'utm_campaign': dbItem.utm_campaign,
        'utm_term': dbItem.utm_term,
        'utm_content': dbItem.utm_content,
        'utm_id': dbItem.utm_id, // [NEW]
        'Last Updated': dbItem.last_updated,
        'Last Updated By': dbItem.last_updated_by || row.get('Last Updated By') // Preserve existing
    });
}


// ==============================================================================
// 2. SYNC MARKETING SPEND (Bidirectional)
// ==============================================================================
async function syncMarketingSpend() {
    const sheet = await getGoogleSheet('Marketing_Spend');
    const rows = await sheet.getRows();
    const { data: dbRows, error } = await supabase.from('marketing_spend').select('*');
    if (error) throw error;

    const stats = { to_sheet: 0, to_db: 0, updates_to_sheet: 0, updates_to_db: 0 };
    const dbMap = new Map(dbRows.map(r => [r.spend_id, r]));
    const sheetMap = new Map(rows.map(r => [r.get('Spend ID'), r]));

    // A. Sheet -> DB
    for (const row of rows) {
        const id = row.get('Spend ID');
        if (!id) continue;
        const dbItem = dbMap.get(id);

        if (!dbItem) {
            await insertSpendToDB(row);
            stats.to_db++;
        } else {
            const sheetTime = parseDate(row.get('Last Updated')) || new Date(0);
            const dbTime = parseDate(dbItem.last_updated) || new Date(0);

            const sheetUser = row.get('Last Updated By');
            const dbUser = dbItem.last_updated_by;

            // PATCH: Backfill missing user in DB
            if (sheetUser && !dbUser) {
                await updateSpendInDB(row);
                stats.updates_to_db++;
            }
            else if (sheetTime > dbTime) {
                await updateSpendInDB(row);
                stats.updates_to_db++;
            } else if (dbTime > sheetTime) {
                updateSpendInSheet(row, dbItem);
                await row.save();
                stats.updates_to_sheet++;
            }
        }
    }

    // B. DB -> Sheet
    for (const dbItem of dbRows) {
        if (!sheetMap.has(dbItem.spend_id)) {
            await insertSpendToSheet(sheet, dbItem);
            stats.to_sheet++;
        }
    }
    return { status: 'success', stats };
}

async function insertSpendToDB(row) {
    await supabase.from('marketing_spend').insert({
        spend_id: row.get('Spend ID'),
        date: row.get('Date'),
        campaign: row.get('Campaign'),
        source: row.get('Source'),
        utm_id: row.get('utm_id'), // [NEW]
        amount: parseFloat(row.get('Ad Spend') || 0),
        impressions: parseInt(row.get('Impressions') || 0),
        clicks: parseInt(row.get('Clicks') || 0),
        last_updated: parseDate(row.get('Last Updated')) || new Date(),
        last_updated_by: row.get('Last Updated By')
    });
}

async function updateSpendInDB(row) {
    await supabase.from('marketing_spend').update({
        date: row.get('Date'),
        campaign: row.get('Campaign'),
        source: row.get('Source'),
        utm_id: row.get('utm_id'), // [NEW]
        amount: parseFloat(row.get('Ad Spend') || 0),
        impressions: parseInt(row.get('Impressions') || 0),
        clicks: parseInt(row.get('Clicks') || 0),
        last_updated: parseDate(row.get('Last Updated')) || new Date(),
        last_updated_by: row.get('Last Updated By')
    }).eq('spend_id', row.get('Spend ID'));
}

async function insertSpendToSheet(sheet, dbItem) {
    await sheet.addRow({
        'Spend ID': dbItem.spend_id,
        'Date': dbItem.date,
        'Campaign': dbItem.campaign,
        'Source': dbItem.source,
        'utm_id': dbItem.utm_id, // [NEW]
        'Ad Spend': dbItem.amount,
        'Impressions': dbItem.impressions,
        'Clicks': dbItem.clicks,
        'Last Updated': dbItem.last_updated,
        'Last Updated By': dbItem.last_updated_by
    });
}

function updateSpendInSheet(row, dbItem) {
    row.assign({
        'Date': dbItem.date,
        'Campaign': dbItem.campaign,
        'Source': dbItem.source,
        'utm_id': dbItem.utm_id, // [NEW]
        'Ad Spend': dbItem.amount,
        'Impressions': dbItem.impressions,
        'Clicks': dbItem.clicks,
        'Last Updated': dbItem.last_updated,
        'Last Updated By': dbItem.last_updated_by || row.get('Last Updated By') // Preserve existing
    });
}


// ==============================================================================
// 3. SYNC CAMPAIGNS (Bidirectional)
// ==============================================================================
async function syncCampaigns() {
    const sheet = await getGoogleSheet('Campaign_Registry');
    const rows = await sheet.getRows();
    const { data: dbRows, error } = await supabase.from('campaigns').select('*');
    if (error) throw error;

    const stats = { to_sheet: 0, to_db: 0, updates_to_sheet: 0, updates_to_db: 0 };
    const dbMap = new Map(dbRows.map(r => [r.name, r])); // Name is PK
    const sheetMap = new Map(rows.map(r => [r.get('Campaign Name'), r]));

    // A. Sheet -> DB
    for (const row of rows) {
        const id = row.get('Campaign Name');
        if (!id) continue;
        const dbItem = dbMap.get(id);

        if (!dbItem) {
            await insertCampaignToDB(row);
            stats.to_db++;
        } else {
            const sheetTime = parseDate(row.get('Last Updated')) || new Date(0);
            const dbTime = parseDate(dbItem.last_updated) || new Date(0);

            const sheetUser = row.get('Last Updated By');
            const dbUser = dbItem.last_updated_by;

            // PATCH: Backfill missing user in DB
            if (sheetUser && !dbUser) {
                await updateCampaignInDB(row);
                stats.updates_to_db++;
            }
            else if (sheetTime > dbTime) {
                await updateCampaignInDB(row);
                stats.updates_to_db++;
            } else if (dbTime > sheetTime) {
                updateCampaignInSheet(row, dbItem);
                await row.save();
                stats.updates_to_sheet++;
            }
        }
    }

    // B. DB -> Sheet
    for (const dbItem of dbRows) {
        if (!sheetMap.has(dbItem.name)) {
            await insertCampaignToSheet(sheet, dbItem);
            stats.to_sheet++;
        }
    }
    return { status: 'success', stats };
}

async function insertCampaignToDB(row) {
    await supabase.from('campaigns').insert({
        name: row.get('Campaign Name'),
        budget: parseFloat(row.get('Budget') || 0),
        start_date: row.get('Start DateTime'),
        end_date: row.get('End DateTime'),
        status: row.get('Status'),
        last_updated: parseDate(row.get('Last Updated')) || new Date(),
        last_updated_by: row.get('Last Updated By'),
        utm_id: row.get('utm_id') // [NEW]
    });
}

async function updateCampaignInDB(row) {
    await supabase.from('campaigns').update({
        budget: parseFloat(row.get('Budget') || 0),
        start_date: row.get('Start DateTime'),
        end_date: row.get('End DateTime'),
        status: row.get('Status'),
        last_updated: parseDate(row.get('Last Updated')) || new Date(),
        last_updated_by: row.get('Last Updated By'),
        utm_id: row.get('utm_id')// [NEW]
    }).eq('name', row.get('Campaign Name'));
}

async function insertCampaignToSheet(sheet, dbItem) {
    await sheet.addRow({
        'Campaign Name': dbItem.name,
        'Budget': dbItem.budget,
        'Start DateTime': dbItem.start_date,
        'End DateTime': dbItem.end_date,
        'Status': dbItem.status,
        'Last Updated': dbItem.last_updated,
        'Last Updated By': dbItem.last_updated_by,
        'utm_id': dbItem.utm_id // [NEW]
    });
}

function updateCampaignInSheet(row, dbItem) {
    row.assign({
        'Budget': dbItem.budget,
        'Start DateTime': dbItem.start_date,
        'End DateTime': dbItem.end_date,
        'Status': dbItem.status,
        'Last Updated': dbItem.last_updated,
        'Last Updated By': dbItem.last_updated_by || row.get('Last Updated By'), // Preserve existing
        'utm_id': dbItem.utm_id // [NEW]
    });
}
