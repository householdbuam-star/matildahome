// Query helpers shared by the HTTP API and tests.
import { ADMIN_ONLY_FIELDS } from './config.js';

const PAGE_LIMIT_MAX = 200;

export function stripAdminFields(item) {
  const out = { ...item };
  for (const f of ADMIN_ONLY_FIELDS) delete out[f];
  return out;
}

/** Remove internal columns that no client needs. */
export function stripInternalFields(item) {
  const out = { ...item };
  delete out.search_text;
  return out;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const PRIMARY_IMAGE_SQL = `(SELECT filename FROM images WHERE images.sku = items.sku ORDER BY sort_order, id LIMIT 1) AS image`;

export function searchItems(db, { q = '', category = '', brand = '', inStock = false, hasImage = false, page = 1, limit = 48 } = {}) {
  const where = []; const params = [];
  const tokens = String(q).toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
  for (const t of tokens) { where.push(`search_text LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(t)}%`); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (brand) { where.push('brand = ?'); params.push(brand); }
  if (inStock) where.push('COALESCE(qty_on_hand, 0) > 0');
  if (hasImage) where.push('EXISTS (SELECT 1 FROM images WHERE images.sku = items.sku)');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const safeLimit = Math.min(Math.max(Number(limit) || 48, 1), PAGE_LIMIT_MAX);
  const safePage = Math.max(Number(page) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM items ${whereSql}`).get(...params).n;

  // Rank: exact SKU/barcode, SKU prefix, SKU contains, then everything else alphabetically.
  const full = tokens.join(' ');
  const rankSql = full
    ? `CASE WHEN lower(sku) = ? OR lower(COALESCE(barcode,'')) = ? THEN 0
            WHEN lower(sku) LIKE ? ESCAPE '\\' THEN 1
            WHEN lower(sku) LIKE ? ESCAPE '\\' THEN 2
            ELSE 3 END,`
    : '';
  const rankParams = full ? [full, full, `${escapeLike(full)}%`, `%${escapeLike(full)}%`] : [];

  const rows = db.prepare(
    `SELECT items.*, ${PRIMARY_IMAGE_SQL} FROM items ${whereSql}
     ORDER BY ${rankSql} description COLLATE NOCASE, sku
     LIMIT ? OFFSET ?`
  ).all(...params, ...rankParams, safeLimit, (safePage - 1) * safeLimit);

  return { items: rows, total, page: safePage, limit: safeLimit, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}

export function getItem(db, sku) {
  const item = db.prepare(`SELECT items.*, ${PRIMARY_IMAGE_SQL} FROM items WHERE sku = ? COLLATE NOCASE`).get(sku);
  if (!item) return null;
  item.images = db.prepare('SELECT id, filename, sort_order FROM images WHERE sku = ? ORDER BY sort_order, id').all(item.sku);
  return item;
}

export function getFacets(db) {
  const categories = db.prepare(`SELECT category AS name, COUNT(*) AS count FROM items WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY category COLLATE NOCASE`).all();
  const brands = db.prepare(`SELECT brand AS name, COUNT(*) AS count FROM items WHERE brand IS NOT NULL AND brand != '' GROUP BY brand ORDER BY brand COLLATE NOCASE`).all();
  return { categories, brands };
}

export function getStats(db) {
  const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const withImages = db.prepare('SELECT COUNT(DISTINCT sku) AS n FROM images').get().n;
  return { items, withImages };
}

/** Build a lookup from a loose key (letters+digits only, lower case) to the real SKU. */
export function buildSkuLookup(db) {
  const map = new Map();
  for (const { sku } of db.prepare('SELECT sku FROM items').all()) {
    map.set(looseKey(sku), sku);
  }
  return map;
}

export function looseKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Match an uploaded image filename to a SKU: "DXB-20989_1.jpg", "dxb-20989-1 (2).JPG", "DXB-20989-1-2.jpg" all resolve. */
export function matchFilenameToSku(filename, lookup) {
  const stem = filename.replace(/\.[^.]+$/, '').trim();
  const candidates = [stem];
  const noParen = stem.replace(/\s*\(\d+\)\s*$/, '');
  if (noParen !== stem) candidates.push(noParen);
  const noSuffix = noParen.replace(/[-_ ]+\d{1,2}$/, '');
  if (noSuffix !== noParen) candidates.push(noSuffix);
  for (const c of candidates) {
    const sku = lookup.get(looseKey(c));
    if (sku) return sku;
  }
  return null;
}
