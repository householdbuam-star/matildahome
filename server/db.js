import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DB_PATH = path.join(DATA_DIR, 'catalog.db');

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  sku           TEXT PRIMARY KEY,
  site          TEXT,
  category_code TEXT,
  category      TEXT,
  brand         TEXT,
  type          TEXT,
  description   TEXT,
  description2  TEXT,
  description3  TEXT,
  barcode       TEXT,
  qty_on_hand   REAL,
  available_qty REAL,
  unit          TEXT,
  volume        REAL,
  po_qty        REAL,
  retail_price  REAL,
  avg_cost      REAL,
  avg_cost_ngn  REAL,
  margin_pct    REAL,
  search_text   TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_brand ON items(brand);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);

CREATE TABLE IF NOT EXISTS images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sku        TEXT NOT NULL REFERENCES items(sku) ON DELETE CASCADE ON UPDATE CASCADE,
  filename   TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_images_sku ON images(sku);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDatabase(filePath = DB_PATH) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(images)').all().map((c) => c.name);
  if (!cols.includes('embedding')) db.exec('ALTER TABLE images ADD COLUMN embedding BLOB');
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
