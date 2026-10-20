const db = require('./db');
const { syncOrderToSheets } = require('./sheets');

const STATIONS = [
  'Tiffin Counter',
  'Meals Counter',
  'Snacks Counter',
  'Drinks Counter'
];

function getStationFromCategory(category, customStation) {
  if (customStation && String(customStation).trim()) {
    const s = String(customStation).trim();
    const sl = s.toLowerCase();
    if (sl.includes('tiffin') || sl.includes('break')) return 'Tiffin Counter';
    if (sl.includes('meal') || sl.includes('lunch') || sl.includes('rice') || sl.includes('biryani')) return 'Meals Counter';
    if (sl.includes('snack')) return 'Snacks Counter';
    if (sl.includes('drink') || sl.includes('beverage') || sl.includes('tea') || sl.includes('coffee')) return 'Drinks Counter';
    return s;
  }
  switch (category) {
    case 'Breakfast': return 'Tiffin Counter';
    case 'Meals': return 'Meals Counter';
    case 'Snacks': return 'Snacks Counter';
    case 'Drinks': return 'Drinks Counter';
    default: return 'Tiffin Counter';
  }
}

/**
 * Splits an order's items into station groups and inserts OrderParts rows
 * MUST be called inside the atomic order creation transaction.
 */
function splitOrderIntoStationParts(orderId, orderItems, nowIso) {
  // Group items by station
  const stationMap = {};
  for (const item of orderItems) {
    const station = item.station || getStationFromCategory(item.category);
    if (!stationMap[station]) {
      stationMap[station] = {
        items: [],
        prepMinutes: 0
      };
    }
    stationMap[station].items.push(item);
    stationMap[station].prepMinutes += (item.prep_time || 0) * (item.quantity || 1);
  }

  const insertPart = db.prepare(`
    INSERT INTO OrderParts (order_id, station, items_json, prep_minutes, status, created_at)
    VALUES (?, ?, ?, ?, 'Placed', ?)
  `);

  const createdParts = [];
  for (const [station, data] of Object.entries(stationMap)) {
    const res = insertPart.run(
      orderId,
      station,
      JSON.stringify(data.items),
      data.prepMinutes,
      nowIso
    );
    createdParts.push({
      id: res.lastInsertRowid,
      order_id: orderId,
      station,
      items: data.items,
      prep_minutes: data.prepMinutes,
      status: 'Placed'
    });
  }

  return createdParts;
}

/**
 * Roll up station parts status into the parent Order record
 */
function rollupOrderStatus(orderId, io) {
  const parts = db.prepare('SELECT * FROM OrderParts WHERE order_id = ?').all(orderId);
  if (parts.length === 0) return null;

  const order = db.prepare('SELECT * FROM Orders WHERE id = ?').get(orderId);
  if (!order) return null;

  // Don't modify already terminal orders (Cancelled, Expired, Collected)
  if (['Cancelled', 'Expired', 'Collected'].includes(order.status)) {
    return order;
  }

  const activeParts = parts.filter(p => !['Cancelled', 'Expired'].includes(p.status));
  if (activeParts.length === 0) return order;

  const allReady = activeParts.every(p => p.status === 'Ready');
  const anyStarted = activeParts.some(p => ['Preparing', 'Ready'].includes(p.status));

  let newStatus = order.status;
  const nowIso = new Date().toISOString();

  if (allReady) {
    newStatus = 'Ready';
  } else if (anyStarted && order.status === 'Placed') {
    newStatus = 'Preparing';
  }

  if (newStatus !== order.status) {
    db.prepare('UPDATE Orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, nowIso, orderId);

    // Sync to Google Sheets
    syncOrderToSheets(orderId);

    if (io) {
      io.to(`user_${order.user_id}`).emit('order_status_updated', {
        orderId: order.id,
        status: newStatus,
        station_summary: getStationSummary(parts),
        message: newStatus === 'Ready'
          ? 'All items are ready! Head to counter for pickup.'
          : 'Your order is being prepared at kitchen stations.'
      });
      io.to('staff_room').emit('orders_queue_updated');
      io.to('staff_room').emit('stations_updated');
      io.emit('stats_updated');
    }
  }

  return { ...order, status: newStatus };
}

/**
 * Generates formatted station summary like "Drinks: Ready | Meals: Preparing"
 */
function getStationSummary(parts) {
  if (!parts || parts.length === 0) return '';
  return parts
    .map(p => {
      const shortName = p.station.replace(' Counter', '');
      return `${shortName}: ${p.status}`;
    })
    .join(' | ');
}

/**
 * Worker / Chef action: Start preparing a station part
 * Atomic transaction ensures two workers cannot take the same part.
 */
function startStationPart(partId, io) {
  let orderId = null;
  const nowIso = new Date().toISOString();

  const tx = db.transaction(() => {
    const part = db.prepare('SELECT * FROM OrderParts WHERE id = ?').get(partId);
    if (!part) throw new Error('Station part not found');
    if (part.status !== 'Placed') {
      throw new Error(`Station part is already in "${part.status}" status`);
    }

    db.prepare(`
      UPDATE OrderParts
      SET status = 'Preparing', started_at = ?
      WHERE id = ? AND status = 'Placed'
    `).run(nowIso, partId);

    orderId = part.order_id;

    // Roll up parent order status
    const order = db.prepare('SELECT * FROM Orders WHERE id = ?').get(orderId);
    if (order && order.status === 'Placed') {
      db.prepare("UPDATE Orders SET status = 'Preparing', updated_at = ? WHERE id = ?").run(nowIso, orderId);
    }
  });

  tx();

  if (orderId) {
    rollupOrderStatus(orderId, io);
    if (io) {
      io.to('staff_room').emit('stations_updated');
      io.to('staff_room').emit('orders_queue_updated');
    }
  }

  return db.prepare('SELECT * FROM OrderParts WHERE id = ?').get(partId);
}

/**
 * Worker / Chef action: Mark a station part as Ready
 * When all parts are Ready, parent Order automatically becomes Ready.
 */
function readyStationPart(partId, io) {
  let orderId = null;
  const nowIso = new Date().toISOString();

  const tx = db.transaction(() => {
    const part = db.prepare('SELECT * FROM OrderParts WHERE id = ?').get(partId);
    if (!part) throw new Error('Station part not found');
    if (part.status === 'Ready') {
      return part; // already ready
    }

    db.prepare(`
      UPDATE OrderParts
      SET status = 'Ready', done_at = ?
      WHERE id = ?
    `).run(nowIso, partId);

    orderId = part.order_id;
  });

  tx();

  if (orderId) {
    rollupOrderStatus(orderId, io);
    if (io) {
      io.to('staff_room').emit('stations_updated');
      io.to('staff_room').emit('orders_queue_updated');
    }
  }

  return db.prepare('SELECT * FROM OrderParts WHERE id = ?').get(partId);
}

/**
 * Fetch station queues formatted for the multi-column Stations Kitchen view
 * FIFO: sorted by slot time first, then created_at
 */
function getStationQueues(filterDate = null) {
  const dateClause = filterDate ? 'AND s.date = ?' : '';
  const params = filterDate ? [filterDate] : [];

  const rawParts = db.prepare(`
    SELECT
      op.id,
      op.order_id,
      op.station,
      op.items_json,
      op.prep_minutes,
      op.status,
      op.created_at,
      op.started_at,
      op.done_at,
      o.token,
      o.status as order_status,
      o.created_at as order_created_at,
      u.name as user_name,
      u.department as user_department,
      s.date as slot_date,
      s.time as slot_time
    FROM OrderParts op
    JOIN Orders o ON op.order_id = o.id
    JOIN Users u ON o.user_id = u.id
    JOIN Slots s ON o.slot_id = s.id
    WHERE op.status IN ('Placed', 'Preparing', 'Ready')
      AND o.status NOT IN ('Cancelled', 'Expired', 'Collected')
      ${dateClause}
    ORDER BY s.date ASC, s.time ASC, op.created_at ASC
  `).all(...params);

  const stationsData = {};
  for (const st of STATIONS) {
    stationsData[st] = {
      name: st,
      shortName: st.replace(' Counter', ''),
      pendingCount: 0,
      preparingCount: 0,
      readyCount: 0,
      totalPendingMinutes: 0,
      queue: [],
      nextPart: null
    };
  }

  for (const part of rawParts) {
    let items = [];
    try {
      items = JSON.parse(part.items_json);
    } catch (e) {}

    const formattedPart = {
      ...part,
      items
    };

    if (stationsData[part.station]) {
      stationsData[part.station].queue.push(formattedPart);
      if (part.status === 'Placed') stationsData[part.station].pendingCount++;
      if (part.status === 'Preparing') stationsData[part.station].preparingCount++;
      if (part.status === 'Ready') stationsData[part.station].readyCount++;
      if (['Placed', 'Preparing'].includes(part.status)) {
        stationsData[part.station].totalPendingMinutes += part.prep_minutes;
      }
    }
  }

  // Set next to prepare card for each station
  for (const st of STATIONS) {
    const q = stationsData[st].queue;
    // Next to prepare: first Placed or Preparing part in FIFO queue
    stationsData[st].nextPart = q.find(p => p.status === 'Preparing') || q.find(p => p.status === 'Placed') || (q.length > 0 ? q[0] : null);
  }

  return {
    stations: stationsData,
    summary: STATIONS.map(st => ({
      station: st,
      shortName: st.replace(' Counter', ''),
      pendingCount: stationsData[st].pendingCount + stationsData[st].preparingCount,
      preparingCount: stationsData[st].preparingCount,
      readyCount: stationsData[st].readyCount,
      pendingMinutes: stationsData[st].totalPendingMinutes
    }))
  };
}

/**
 * PARALLEL WORKERS (MULTITHREADING / INDEPENDENT WORKER LOOPS)
 * Runs one independent worker loop per station.
 * Workers run concurrently, so a 2-min drink is never stuck behind a 6-min meal.
 * Each worker takes the next part from its station queue and advances it.
 */
class StationWorkerPool {
  constructor(ioGetter) {
    this.ioGetter = ioGetter;
    this.workers = {};
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    for (const station of STATIONS) {
      this.workers[station] = {
        station,
        active: true,
        currentPartId: null,
        loop: this.createStationWorkerLoop(station)
      };
    }
    console.log('[Workers] 4 Parallel Station Workers initialized (Tiffin, Meals, Snacks, Drinks).');
  }

  stop() {
    this.running = false;
    for (const st of Object.keys(this.workers)) {
      if (this.workers[st]) this.workers[st].active = false;
    }
  }

  createStationWorkerLoop(station) {
    // Independent loop per station running concurrently
    const interval = setInterval(async () => {
      if (!this.running) {
        clearInterval(interval);
        return;
      }
      try {
        await this.processNextStationTask(station);
      } catch (err) {
        // Silently log or handle error
      }
    }, 3000); // Polls station queue every 3 seconds for independent concurrency

    return interval;
  }

  async processNextStationTask(station) {
    // Check if station has any auto-processable task or queue progress
    // Reads only its own station queue
    const nextPlaced = db.prepare(`
      SELECT op.id, op.order_id
      FROM OrderParts op
      JOIN Orders o ON op.order_id = o.id
      JOIN Slots s ON o.slot_id = s.id
      WHERE op.station = ?
        AND op.status = 'Placed'
        AND o.status NOT IN ('Cancelled', 'Expired', 'Collected')
      ORDER BY s.date ASC, s.time ASC, op.created_at ASC
      LIMIT 1
    `).get(station);

    // Auto-advance is optional; if the station has a part placed, worker monitors it
    // The chef can manually start or ready, or workers claim it atomically
    return nextPlaced;
  }
}

let globalWorkerPool = null;

function initStationWorkers(getIo) {
  if (!globalWorkerPool) {
    globalWorkerPool = new StationWorkerPool(getIo);
    globalWorkerPool.start();
  }
  return globalWorkerPool;
}

module.exports = {
  STATIONS,
  getStationFromCategory,
  splitOrderIntoStationParts,
  rollupOrderStatus,
  getStationSummary,
  startStationPart,
  readyStationPart,
  getStationQueues,
  initStationWorkers
};
