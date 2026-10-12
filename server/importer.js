import XLSX from 'xlsx';

// Header aliases, normalised (lower-case, non-alphanumerics stripped).
// First alias that matches a column wins, so order matters where names overlap.
const FIELD_ALIASES = {
  sku:           ['product', 'sku', 'skucode', 'itemcode', 'item', 'productcode', 'code', 'reference'],
  category:      ['catagory', 'categoryname', 'categorydescription', 'categorydesc'],
  category_code: ['category', 'categorycode', 'catcode', 'cat'],
  site:          ['site', 'warehouse', 'location'],
  brand:         ['brand', 'manufacturer', 'supplier'],
  type:          ['type', 'subcategory', 'style'],
  description:   ['description1', 'description', 'name', 'productname', 'itemname', 'title', 'desc'],
  description2:  ['description2', 'desc2', 'shortdescription'],
  description3:  ['description3', 'desc3', 'longdescription'],
  barcode:       ['barcodecode', 'barcode', 'ean', 'upc', 'gtin'],
  qty_on_hand:   ['qtyonhand', 'quantityonhand', 'qty', 'quantity', 'stock', 'onhand', 'stockqty'],
  available_qty: ['availibleqty', 'availableqty', 'available', 'availablequantity'],
  unit:          ['unit', 'uom', 'volumeunit'],
  volume:        ['volume', 'cbm'],
  po_qty:        ['poqty', 'purchaseorderqty', 'onorder'],
  retail_price:  ['retailprice', 'retail', 'sellingprice', 'saleprice', 'price', 'rrp', 'listprice'],
  avg_cost:      ['averagecost', 'avgcost', 'cost', 'unitcost', 'costprice', 'costusd'],
  avg_cost_ngn:  ['avginngn', 'avgcostngn', 'costngn', 'averagecostngn', 'costinngn', 'localcost'],
  margin_pct:    ['percentage', 'margin', 'marginpct', 'markup', 'margin%'],
};

const NUMERIC_FIELDS = new Set(['qty_on_hand', 'available_qty', 'volume', 'po_qty', 'retail_price', 'avg_cost', 'avg_cost_ngn', 'margin_pct']);
export const ITEM_FIELDS = Object.keys(FIELD_ALIASES);

export function normaliseHeader(h) {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '');
}

// Clean up quoting artefacts that Sage leaves in descriptions. The export escapes quotes
// (sometimes several times) and truncates at 30 characters, so we see things like
//   "ATV SMALL ATV009 7"" BLUE"      -> ATV SMALL ATV009 7" BLUE
//   """KARACA AFRICAN 6"""" AH?AP    -> KARACA AFRICAN 6" AH?AP
//   " Air Fryer 1400-1600W "         -> Air Fryer 1400-1600W
export function cleanText(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/\s+/g, ' ').trim();
  s = s.replace(/"{2,}/g, '"');
  if (s.startsWith('"')) {
    s = s.slice(1);
    if (s.endsWith('"')) s = s.slice(0, -1);
  }
  s = s.trim();
  return s === '' ? null : s;
}

export function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s]/g, '').replace(/^[^\d.-]+/, '');
  if (s === '' || s === '-' ) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Map a header row to {field: columnIndex}. Returns null when no SKU column is present. */
export function mapHeaders(headerRow) {
  const normalised = headerRow.map(normaliseHeader);
  const mapping = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalised.findIndex((h, i) => h === alias && !used.has(i));
      if (idx !== -1) { mapping[field] = idx; used.add(idx); break; }
    }
  }
  if (mapping.sku === undefined) return null;
  // A sheet with only a "Category" column: treat it as the display name too.
  if (mapping.category === undefined && mapping.category_code !== undefined) mapping.category = mapping.category_code;
  return mapping;
}

function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row || row.filter((c) => c !== null && c !== '').length < 2) continue;
    const mapping = mapHeaders(row);
    if (mapping) return { index: i, mapping };
  }
  return null;
}

export function rowsToItems(rows) {
  const header = findHeaderRow(rows);
  if (!header) throw new Error('Could not find a header row with a Product/SKU column.');
  const { index, mapping } = header;
  const items = [];
  const seen = new Set();
  for (let r = index + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const sku = cleanText(row[mapping.sku]);
    if (!sku) continue;
    const key = sku.toUpperCase();
    if (seen.has(key)) continue; // keep first occurrence of a duplicated SKU
    seen.add(key);
    const item = { sku };
    for (const [field, col] of Object.entries(mapping)) {
      if (field === 'sku') continue;
      const raw = row[col];
      item[field] = NUMERIC_FIELDS.has(field) ? parseNumber(raw) : cleanText(raw);
    }
    if (!item.description) item.description = sku;
    items.push(item);
  }
  return { items, mapping, headerRowIndex: index };
}

/** Parse an .xlsx/.xls/.csv buffer and return the items of the sheet that looks most like an item list. */
export function parseWorkbook(buffer, filename = '') {
  const isCsv = /\.(csv|txt|tsv)$/i.test(filename);
  const wb = XLSX.read(buffer, { type: 'buffer', cellStyles: false, cellHTML: false, raw: true, ...(isCsv ? { type: 'buffer' } : {}) });
  let best = null;
  const errors = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false });
    if (rows.length < 2) continue;
    try {
      const parsed = rowsToItems(rows);
      if (!best || parsed.items.length > best.items.length) best = { ...parsed, sheet: name };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  if (!best) throw new Error(errors[0] || 'No sheet with an item list was found.');
  return best;
}

export function buildSearchText(item) {
  return [item.sku, item.description, item.description2, item.description3, item.barcode, item.brand, item.category, item.category_code, item.type]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
}

/** Upsert items into the database. Returns counts. */
export function importItems(db, items, { removeMissing = false } = {}) {
  const columns = ['sku', 'site', 'category_code', 'category', 'brand', 'type', 'description', 'description2', 'description3', 'barcode',
    'qty_on_hand', 'available_qty', 'unit', 'volume', 'po_qty', 'retail_price', 'avg_cost', 'avg_cost_ngn', 'margin_pct', 'search_text'];
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns.filter((c) => c !== 'sku').map((c) => `${c} = excluded.${c}`).join(', ');
  const upsert = db.prepare(
    `INSERT INTO items (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(sku) DO UPDATE SET ${updates}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );
  const exists = db.prepare('SELECT 1 FROM items WHERE sku = ?');

  let inserted = 0; let updated = 0; let removed = 0;
  db.exec('BEGIN');
  try {
    const incoming = new Set();
    for (const item of items) {
      incoming.add(item.sku);
      if (exists.get(item.sku)) updated++; else inserted++;
      const values = columns.map((c) => (c === 'search_text' ? buildSearchText(item) : item[c] ?? null));
      upsert.run(...values);
    }
    if (removeMissing) {
      const all = db.prepare('SELECT sku FROM items').all();
      const del = db.prepare('DELETE FROM items WHERE sku = ?');
      for (const { sku } of all) {
        if (!incoming.has(sku)) { del.run(sku); removed++; }
      }
    }
    db.prepare("INSERT INTO meta(key, value) VALUES ('last_import', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { inserted, updated, removed, total: items.length };
}
