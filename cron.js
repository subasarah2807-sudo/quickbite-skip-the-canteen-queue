const cron = require('node-cron');
const db = require('./db');

/**
 * Helper to get current operational date & time.
 * Supports demo simulation time if enabled in AppSettings.
 */
function getCurrentCanteenTime() {
  const modeSetting = db.prepare("SELECT value FROM AppSettings WHERE key = 'simulated_time_mode'").get();
  const timeSetting = db.prepare("SELECT value FROM AppSettings WHERE key = 'demo_simulated_time'").get();

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  if (modeSetting && modeSetting.value === 'demo' && timeSetting && timeSetting.value) {
    const [hh, mm] = timeSetting.value.split(':').map(Number);
    const demoDate = new Date(year, now.getMonth(), now.getDate(), hh, mm, 0);
    return {
      date: dateStr,
      time: timeSetting.value,
      fullDate: demoDate,
      isDemo: true
    };
  }

  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  return {
    date: dateStr,
    time: `${hours}:${mins}`,
    fullDate: now,
    isDemo: false
  };
}

/**
 * Checks for orders that have not been collected 10 minutes after slot end (20 mins after slot start).
 * Frees capacity and stock, marks status = 'Expired'.
 */
function checkExpiredOrders(io) {
  try {
    const current = getCurrentCanteenTime();
    const currentDate = current.date;
    const currentFullTime = current.fullDate.getTime();

    // Find orders eligible for expiry
    const pendingOrders = db.prepare(`
      SELECT o.id, o.user_id, o.slot_id, o.items_json, o.status, o.token,
             s.date as slot_date, s.time as slot_time, s.max_prep_minutes
      FROM Orders o
      JOIN Slots s ON o.slot_id = s.id
      WHERE o.status IN ('Placed', 'Preparing', 'Ready')
        AND o.token_used = 0
    `).all();

    const expiredOrders = [];

    for (const ord of pendingOrders) {
      // Parse slot datetime: e.g., "2026-10-18 10:00"
      const [year, month, day] = ord.slot_date.split('-').map(Number);
      const [hour, minute] = ord.slot_time.split(':').map(Number);
      const slotStartTime = new Date(year, month - 1, day, hour, minute, 0).getTime();
      
      // 10 min slot duration + 10 min grace period = 20 mins after slot start
      const expiryThreshold = slotStartTime + (20 * 60 * 1000);

      if (currentFullTime >= expiryThreshold) {
        expiredOrders.push(ord);
      }
    }

    if (expiredOrders.length === 0) return;

    const updateOrderStmt = db.prepare(`
      UPDATE Orders SET status = 'Expired', updated_at = ? WHERE id = ?
    `);
    const updatePartsStmt = db.prepare(`
      UPDATE OrderParts SET status = 'Expired' WHERE order_id = ?
    `);
    const updateStockStmt = db.prepare(`
      UPDATE Menu SET stock = stock + ? WHERE id = ?
    `);
    const updateSlotStmt = db.prepare(`
      UPDATE Slots SET booked_minutes = MAX(0, booked_minutes - ?) WHERE id = ?
    `);

    const expireTransaction = db.transaction(() => {
      const nowIso = new Date().toISOString();
      for (const ord of expiredOrders) {
        updateOrderStmt.run(nowIso, ord.id);
        updatePartsStmt.run(ord.id);

        let items = [];
        try {
          items = JSON.parse(ord.items_json);
        } catch (e) {
          console.error('Failed to parse items_json for order', ord.id);
        }

        let totalPrep = 0;
        for (const item of items) {
          totalPrep += (item.prep_time || 0) * (item.quantity || 1);
          updateStockStmt.run(item.quantity || 1, item.id);
        }

        updateSlotStmt.run(totalPrep, ord.slot_id);
      }
    });

    expireTransaction();

    console.log(`[Auto-Expiry] Marked ${expiredOrders.length} orders as Expired.`);

    // Broadcast updates via Socket.io
    if (io) {
      const { syncOrderToSheets } = require('./sheets');
      for (const ord of expiredOrders) {
        syncOrderToSheets(ord.id);
        io.to(`user_${ord.user_id}`).emit('order_status_updated', {
          orderId: ord.id,
          status: 'Expired',
          message: 'Your order was not collected within 10 minutes of slot end and has expired.'
        });
      }
      io.to('staff_room').emit('orders_queue_updated');
      io.to('staff_room').emit('stations_updated');
      io.emit('menu_updated');
      io.emit('slots_updated');
      io.emit('stats_updated');
    }
  } catch (err) {
    console.error('[Auto-Expiry Error]', err);
  }
}

function startExpiryCron(io) {
  const { retryPendingSyncQueue } = require('./sheets');

  // Run every 60 seconds
  cron.schedule('* * * * *', () => {
    checkExpiredOrders(io);
    retryPendingSyncQueue().catch(e => console.error('Sheets retry error:', e));
  });
  console.log('[Cron] Order auto-expiry and Google Sheets retry cron initialized (runs every 1 min).');
}

module.exports = {
  startExpiryCron,
  checkExpiredOrders,
  getCurrentCanteenTime
};

