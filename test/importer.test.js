import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseWorkbook, rowsToItems, cleanText, parseNumber, importItems } from '../server/importer.js';
import { openDatabase } from '../server/db.js';
import { searchItems, getItem, stripAdminFields, buildSkuLookup, matchFilenameToSku } from '../server/catalog.js';

const HEADER = ['Category', 'Site', 'Brand', 'Type', 'Catagory', 'Product', 'Description 1', 'Description 2', 'Description 3', 'Barcode code', 'QTY on Hand', 'unit', 'Volume', 'Availible QTY', 'SO qry', 'PO qty', 'In transit', 'Retail Price', 'Average cost', 'AVG in NGN', 'Percentage'];
const ROWS = [
  ['ACC01', 'HHHQ', 'DUBAI', '', 'Accessories', 'DXB-20989/1', '20989/1-INCENSE BURNER', '20989/1-INCENSE BURNER', '', '', null, '', null, null, null, null, null, 15000, 6.375, 9562.5, 56.8],
  ['ACC01', 'HHHQ', 'CHINA', 'MODER', 'Accessories', 'CHATV-SME3-6', '"ATV SMALL ATV009 7"" BLUE"', '', '', '6291234567890', 3, 'M3', 0.36, 3, null, null, null, '1,250,000', 353.75, 530625, -100],
  ['HOUSE', 'HHHQ', 'BINAT', '', 'Household ', 'BINAAIRCOBAC-201', 'BINATONE AIR COOLER BAC-201', 'BAC-201', '', '', 0, 'M3', null, 0, null, 2, null, null, 80, 120000, null],
];

test('rowsToItems maps Sage X3 headers, cleans quotes and numbers', () => {
  const { items, mapping } = rowsToItems([['junk', null], HEADER, ...ROWS]);
  assert.equal(items.length, 3);
  assert.equal(mapping.sku, 5);
  assert.equal(mapping.category, 4, 'Catagory column is the display name');
  assert.equal(mapping.category_code, 0);
  const atv = items[1];
  assert.equal(atv.description, 'ATV SMALL ATV009 7" BLUE');
  assert.equal(atv.retail_price, 1250000);
  assert.equal(atv.barcode, '6291234567890');
  assert.equal(atv.qty_on_hand, 3);
  assert.equal(items[2].category, 'Household');
  assert.equal(items[2].po_qty, 2);
  assert.equal(items[2].retail_price, null);
});

test('parseWorkbook picks the sheet with items and ignores Sage reserved sheets', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['{"dictionnaryAddress":"A1"}'], ['https://host']]), 'Sage.X3.ReservedSheet');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...ROWS]), 'Sage.X3.DS.');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet2');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const parsed = parseWorkbook(buf, 'items.xlsx');
  assert.equal(parsed.sheet, 'Sage.X3.DS.');
  assert.equal(parsed.items.length, 3);
});

test('parseWorkbook reads CSV with simpler headers', () => {
  const csv = 'SKU,Name,Price,Cost,Category\nA-1,Red chair,"12,000",5000,Chairs\nA-2,Blue chair,13000,5100,Chairs\n';
  const parsed = parseWorkbook(Buffer.from(csv), 'list.csv');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].retail_price, 12000);
  assert.equal(parsed.items[0].avg_cost, 5000);
  assert.equal(parsed.items[0].category, 'Chairs');
});

test('helpers', () => {
  assert.equal(cleanText('  a   b '), 'a b');
  assert.equal(cleanText(''), null);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('₦12,000'), 12000);
  assert.equal(parseNumber('abc'), null);
});

test('importItems upserts, search ranks exact SKU first, admin fields are strippable', () => {
  const db = openDatabase(':memory:');
  const { items } = rowsToItems([HEADER, ...ROWS]);
  let r = importItems(db, items);
  assert.deepEqual([r.inserted, r.updated, r.removed], [3, 0, 0]);
  r = importItems(db, items.slice(0, 2), { removeMissing: true });
  assert.deepEqual([r.inserted, r.updated, r.removed], [0, 2, 1]);
  assert.equal(getItem(db, 'BINAAIRCOBAC-201'), null);

  const res = searchItems(db, { q: 'incense' });
  assert.equal(res.total, 1);
  assert.equal(res.items[0].sku, 'DXB-20989/1');
  assert.equal(searchItems(db, { q: 'dxb-20989/1' }).items[0].sku, 'DXB-20989/1');
  assert.equal(searchItems(db, { q: '6291234567890' }).items[0].sku, 'CHATV-SME3-6');
  assert.equal(searchItems(db, { q: 'atv blue' }).total, 1);
  assert.equal(searchItems(db, { q: 'nothing here' }).total, 0);
  assert.equal(searchItems(db, { inStock: true }).total, 1);
  assert.equal(searchItems(db, { q: '%' }).total, 0, 'LIKE wildcards are escaped');

  const item = getItem(db, 'chatv-sme3-6');
  assert.equal(item.avg_cost, 353.75);
  const pub = stripAdminFields(item);
  assert.equal(pub.avg_cost, undefined);
  assert.equal(pub.avg_cost_ngn, undefined);
  assert.equal(pub.margin_pct, undefined);
  assert.equal(pub.retail_price, 1250000);
});

test('image file names match SKUs loosely', () => {
  const db = openDatabase(':memory:');
  importItems(db, rowsToItems([HEADER, ...ROWS]).items);
  const lookup = buildSkuLookup(db);
  assert.equal(matchFilenameToSku('DXB-20989_1.jpg', lookup), 'DXB-20989/1');
  assert.equal(matchFilenameToSku('dxb-20989-1 (2).JPG', lookup), 'DXB-20989/1');
  assert.equal(matchFilenameToSku('DXB-20989-1-2.png', lookup), 'DXB-20989/1');
  assert.equal(matchFilenameToSku('chatv sme3 6.jpeg', lookup), 'CHATV-SME3-6');
  assert.equal(matchFilenameToSku('unknown.jpg', lookup), null);
});
