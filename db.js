const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'quickbite.db');
const db = new Database(dbPath);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      department TEXT,
      username TEXT,
      password_hash TEXT,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'student'
    );

    CREATE TABLE IF NOT EXISTS Menu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('Breakfast', 'Meals', 'Snacks', 'Drinks')),
      station TEXT NOT NULL DEFAULT 'Tiffin Counter', -- 'Tiffin Counter', 'Meals Counter', 'Snacks Counter', 'Drinks Counter'
      price REAL NOT NULL,
      prep_time INTEGER NOT NULL, -- in minutes
      stock INTEGER NOT NULL DEFAULT 50,
      available INTEGER NOT NULL DEFAULT 1, -- 1 for true, 0 for false
      veg INTEGER NOT NULL DEFAULT 1, -- 1 for veg, 0 for non-veg
      image TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, -- YYYY-MM-DD
      time TEXT NOT NULL, -- HH:mm (e.g. "09:00", "09:10")
      max_prep_minutes INTEGER NOT NULL DEFAULT 20,
      booked_minutes INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date, time)
    );

    CREATE TABLE IF NOT EXISTS Orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      slot_id INTEGER NOT NULL,
      items_json TEXT NOT NULL, -- JSON array of [{ id, name, price, quantity, prep_time, veg }]
      total REAL NOT NULL,
      token TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Placed', 'Preparing', 'Ready', 'Collected', 'Cancelled', 'Expired')),
      token_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES Users(id),
      FOREIGN KEY(slot_id) REFERENCES Slots(id)
    );

    CREATE TABLE IF NOT EXISTS AppSettings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS SyncQueue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      retries INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS OrderParts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES Orders(id) ON DELETE CASCADE,
      station TEXT NOT NULL,
      items_json TEXT NOT NULL,
      prep_minutes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Placed' CHECK(status IN ('Placed', 'Preparing', 'Ready', 'Collected', 'Cancelled', 'Expired')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      done_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orderparts_order_id ON OrderParts(order_id);
    CREATE INDEX IF NOT EXISTS idx_orderparts_station_status ON OrderParts(station, status);
  `);

  // Migrate existing Menu table for station column if needed
  try {
    const menuCols = db.prepare("PRAGMA table_info(Menu)").all().map(c => c.name);
    if (!menuCols.includes('station')) {
      db.exec("ALTER TABLE Menu ADD COLUMN station TEXT DEFAULT 'Tiffin Counter';");
    }
    // Ensure all existing menu items have station populated based on category
    db.exec(`
      UPDATE Menu SET station = CASE
        WHEN category = 'Breakfast' THEN 'Tiffin Counter'
        WHEN category = 'Meals' THEN 'Meals Counter'
        WHEN category = 'Snacks' THEN 'Snacks Counter'
        WHEN category = 'Drinks' THEN 'Drinks Counter'
        ELSE 'Tiffin Counter'
      END WHERE station IS NULL OR station = '';
    `);
  } catch (err) {
    console.error('Menu table station migration notice:', err.message);
  }

  // Migrate existing Users table columns and CHECK constraint if needed
  try {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='Users'").get()?.sql || '';
    if (!tableSql.includes("'chef'") || !tableSql.includes('department')) {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE IF NOT EXISTS Users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          department TEXT,
          username TEXT,
          password_hash TEXT,
          email TEXT,
          role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student', 'chef', 'staff'))
        );
        INSERT OR IGNORE INTO Users_new (id, name, email, role)
        SELECT id, name, email, CASE WHEN role = 'staff' THEN 'chef' ELSE role END FROM Users;
        DROP TABLE Users;
        ALTER TABLE Users_new RENAME TO Users;
      `);
      db.pragma('foreign_keys = ON');
    }
  } catch (err) {
    console.error('Users table migration notice:', err.message);
  }
}

initDb();

module.exports = db;
