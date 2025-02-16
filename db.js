const Database = require("better-sqlite3");
const db = new Database("payments.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS configs (
    id INTEGER PRIMARY KEY,
    fee_ps_fixed REAL NOT NULL,
    fee_ps_percent REAL NOT NULL,
    temp_hold_percent REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS merchants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    commission_percent REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    amount REAL NOT NULL,
    available_balance REAL DEFAULT 0,
    status TEXT CHECK(status IN ('accepted','processed','executed','paid'))
  );
`);

module.exports = db;
