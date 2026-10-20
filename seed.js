const db = require('./db');
const bcrypt = require('bcryptjs');

const CHEF_USER = {
  name: 'Head Chef Murugan',
  username: 'chef',
  password: 'chef123',
  role: 'chef'
};

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function generateTimeSlots(startHour = 9, endHour = 17, stepMinutes = 10) {
  const slots = [];
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += stepMinutes) {
      const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      slots.push(timeStr);
    }
  }
  return slots;
}

function seedChef() {
  const hash = bcrypt.hashSync(CHEF_USER.password, 10);

  const existingChef = db.prepare("SELECT * FROM Users WHERE username = 'chef' OR role IN ('chef', 'staff')").get();
  if (!existingChef) {
    db.prepare(`
      INSERT INTO Users (name, username, password_hash, role)
      VALUES (?, ?, ?, 'chef')
    `).run(CHEF_USER.name, CHEF_USER.username, hash);
    console.log('[Seed] Seeded Chef account (username: chef)');
  } else {
    db.prepare(`
      UPDATE Users SET name = ?, username = 'chef', password_hash = ?, role = 'chef'
      WHERE id = ?
    `).run(CHEF_USER.name, hash, existingChef.id);
  }
}

function seedSlotsForDate(dateStr) {
  const times = generateTimeSlots(9, 17, 10);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO Slots (date, time, max_prep_minutes, booked_minutes)
    VALUES (?, ?, 20, 0)
  `);

  const runAll = db.transaction(() => {
    for (const t of times) {
      insert.run(dateStr, t);
    }
  });
  runAll();
}

function seedDefaultSettings() {
  const insert = db.prepare('INSERT OR IGNORE INTO AppSettings (key, value) VALUES (?, ?)');
  insert.run('default_max_prep_minutes', '20');
}

/**
 * Clean database so the app starts with zero orders, zero students, and zero hardcoded menu items.
 * Only the chef account stays seeded.
 */
function cleanDatabase() {
  const runClean = db.transaction(() => {
    // Delete all order parts and orders
    db.prepare('DELETE FROM OrderParts').run();
    db.prepare('DELETE FROM Orders').run();
    // Delete all students (keep only chef)
    db.prepare("DELETE FROM Users WHERE role != 'chef'").run();
    // Clear menu so it comes from CSV or Google Sheets
    db.prepare('DELETE FROM Menu').run();
    // Reset slot booked minutes
    db.prepare('UPDATE Slots SET booked_minutes = 0').run();
    // Clear sync queue
    db.prepare('DELETE FROM SyncQueue').run();
  });
  runClean();
  console.log('[Seed] Database cleaned: 0 orders, 0 students, 0 menu items.');
}

function initAll(clean = false) {
  if (clean) {
    cleanDatabase();
  }
  seedChef();
  const today = getTodayString();
  seedSlotsForDate(today);
  seedDefaultSettings();
}

module.exports = {
  initAll,
  cleanDatabase,
  seedChef,
  seedSlotsForDate,
  getTodayString,
  CHEF_USER
};

if (require.main === module) {
  // If run directly: clean and initialize
  initAll(true);
  console.log('Database initialized with empty start (Chef only).');
}
