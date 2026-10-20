const db = require('./db');

function getSheetsConfig() {
  return {
    webhookUrl: process.env.SHEETS_WEBHOOK_URL ? process.env.SHEETS_WEBHOOK_URL.trim() : ''
  };
}

/**
 * Builds the payload for a given order ID.
 */
function buildOrderPayload(orderId) {
  const row = db.prepare(`
    SELECT o.id as orderId, o.total, o.token, o.status, o.created_at, o.updated_at,
           o.items_json, s.date as slot_date, s.time as slot_time,
           u.name as studentName, u.department
    FROM Orders o
    JOIN Slots s ON o.slot_id = s.id
    JOIN Users u ON o.user_id = u.id
    WHERE o.id = ?
  `).get(orderId);

  if (!row) return null;

  let itemsStr = '';
  try {
    const items = JSON.parse(row.items_json);
    itemsStr = items.map(it => `${it.quantity}x ${it.name}`).join(', ');
  } catch (e) {
    itemsStr = 'Order items';
  }

  const timePlaced = row.created_at ? new Date(row.created_at).toLocaleTimeString() : '';

  // Station status breakdown rollup (e.g. "Drinks: Ready | Meals: Preparing")
  let stationStatus = row.status;
  try {
    const rawParts = db.prepare('SELECT station, status FROM OrderParts WHERE order_id = ?').all(orderId);
    if (rawParts.length > 0) {
      stationStatus = rawParts.map(p => `${p.station.replace(' Counter', '')}: ${p.status}`).join(' | ');
    }
  } catch (e) {}

  return {
    action: 'upsert',
    orderId: String(row.orderId),
    date: row.slot_date,
    timePlaced: timePlaced,
    studentName: row.studentName || 'Student',
    department: row.department || 'Other',
    items: itemsStr,
    total: row.total,
    slot: row.slot_time,
    token: row.token,
    status: row.status,
    stationStatus: stationStatus,
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Sends a single payload to the Google Apps Script Webhook.
 */
async function sendToWebhook(payload, webhookUrl) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });

  if (!res.ok) {
    throw new Error(`Sheets Webhook returned HTTP ${res.status}`);
  }

  const data = await res.json().catch(() => ({}));
  if (data && data.success === false) {
    throw new Error(data.error || 'Webhook execution failed');
  }
  return data;
}

/**
 * Dispatches an order update to Google Sheets asynchronously.
 * Retries up to 3 times, then saves to SyncQueue.
 */
function syncOrderToSheets(orderId) {
  setImmediate(async () => {
    try {
      const { webhookUrl } = getSheetsConfig();
      if (!webhookUrl) return;

      const payload = buildOrderPayload(orderId);
      if (!payload) return;

      let success = false;
      let lastError = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await sendToWebhook(payload, webhookUrl);
          success = true;
          break;
        } catch (err) {
          lastError = err;
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!success) {
        console.warn(`[Google Sheets] Immediate sync failed for Order #${orderId}. Queuing:`, lastError?.message);
        const nowIso = new Date().toISOString();
        db.prepare(`
          INSERT INTO SyncQueue (payload, retries, status, error, created_at, updated_at)
          VALUES (?, 3, 'pending', ?, ?, ?)
        `).run(JSON.stringify(payload), lastError?.message || 'Sync failed', nowIso, nowIso);
      } else {
        console.log(`[Google Sheets] Order #${orderId} synced successfully.`);
      }
    } catch (err) {
      console.error('[Google Sheets Order Sync Error]', err);
    }
  });
}

/**
 * Dispatches a menu item stock / availability update to Google Sheets asynchronously.
 */
function syncMenuItemToSheets(item) {
  setImmediate(async () => {
    try {
      const { webhookUrl } = getSheetsConfig();
      if (!webhookUrl || !item || !item.name) return;

      const payload = {
        action: 'update_menu_item',
        name: item.name,
        category: item.category,
        price: item.price,
        prep_time: item.prep_time,
        stock: item.stock,
        veg: item.veg === 1 ? 'yes' : 'no',
        image: item.image,
        available: item.available === 1 ? 'yes' : 'no'
      };

      await sendToWebhook(payload, webhookUrl);
      console.log(`[Google Sheets] Menu item "${item.name}" synced to Menu tab.`);
    } catch (err) {
      console.warn(`[Google Sheets] Menu item sync notice for "${item?.name}":`, err.message);
    }
  });
}

/**
 * Fetches the Menu tab from Google Sheets via GET request.
 */
async function fetchMenuFromSheets() {
  const { webhookUrl } = getSheetsConfig();
  if (!webhookUrl) {
    throw new Error('SHEETS_WEBHOOK_URL is not set in environment variables.');
  }

  const url = `${webhookUrl}?action=menu`;
  const res = await fetch(url, { method: 'GET', redirect: 'follow' });

  if (!res.ok) {
    throw new Error(`Google Sheets responded with HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data || !data.success) {
    throw new Error(data?.error || 'Failed to parse menu from Google Sheet');
  }

  return data.menu || [];
}

/**
 * Retries pending items from SyncQueue (called by node-cron every minute).
 */
async function retryPendingSyncQueue() {
  const { webhookUrl } = getSheetsConfig();
  if (!webhookUrl) return;

  const pending = db.prepare(`
    SELECT * FROM SyncQueue WHERE status = 'pending' LIMIT 20
  `).all();

  if (pending.length === 0) return;

  for (const item of pending) {
    try {
      const payload = JSON.parse(item.payload);
      await sendToWebhook(payload, webhookUrl);

      db.prepare(`
        UPDATE SyncQueue
        SET status = 'synced', updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), item.id);
    } catch (err) {
      db.prepare(`
        UPDATE SyncQueue
        SET retries = retries + 1, error = ?, updated_at = ?
        WHERE id = ?
      `).run(err.message, new Date().toISOString(), item.id);
    }
  }
}

/**
 * Returns current sync status for chef dashboard indicator.
 */
function getSyncStatus() {
  const { webhookUrl } = getSheetsConfig();
  const pendingCount = db.prepare("SELECT COUNT(*) as count FROM SyncQueue WHERE status = 'pending'").get()?.count || 0;

  return {
    configured: Boolean(webhookUrl),
    pendingCount: pendingCount,
    status: !webhookUrl ? 'not_configured' : (pendingCount > 0 ? 'pending' : 'synced')
  };
}

module.exports = {
  syncOrderToSheets,
  syncMenuItemToSheets,
  fetchMenuFromSheets,
  retryPendingSyncQueue,
  getSyncStatus
};
