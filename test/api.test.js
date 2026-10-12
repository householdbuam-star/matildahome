import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ADMIN_USERNAME = 'boss';
process.env.ADMIN_PASSWORD = 'secret-pw';
process.env.SESSION_SECRET = 'test-secret';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));

const { createApp } = await import('../server/index.js');
const { openDatabase } = await import('../server/db.js');
const { importItems } = await import('../server/importer.js');
const { IMAGES_DIR } = await import('../server/config.js');

let server; let base; let db;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  db = openDatabase(':memory:');
  importItems(db, [
    { sku: 'DXB-20989/1', description: 'INCENSE BURNER', category: 'Accessories', brand: 'DUBAI', retail_price: 15000, avg_cost: 6.375, avg_cost_ngn: 9562.5, margin_pct: 56.8, site: 'HHHQ' },
    { sku: 'CHAIR-1', description: 'Dining chair', category: 'Household', brand: 'CHINA', retail_price: 90000, avg_cost: 30, avg_cost_ngn: 45000, margin_pct: 100, qty_on_hand: 4 },
  ]);
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const json = async (res) => ({ status: res.status, body: await res.json() });

test('public users never see cost fields', async () => {
  const { body } = await json(await fetch(`${base}/api/items?q=incense`));
  assert.equal(body.total, 1);
  const it = body.items[0];
  assert.equal(it.retail_price, 15000);
  assert.equal(it.avg_cost, undefined);
  assert.equal(it.avg_cost_ngn, undefined);
  assert.equal(it.margin_pct, undefined);
  assert.equal(it.site, undefined);

  const single = await json(await fetch(`${base}/api/items/${encodeURIComponent('DXB-20989/1')}`));
  assert.equal(single.status, 200);
  assert.equal(single.body.sku, 'DXB-20989/1');
  assert.equal(single.body.avg_cost, undefined);
  assert.ok(Array.isArray(single.body.images));

  const cfg = await json(await fetch(`${base}/api/config`));
  assert.equal(cfg.body.isAdmin, false);
  assert.equal(cfg.body.adminEnabled, true);
});

test('admin endpoints reject anonymous users', async () => {
  assert.equal((await fetch(`${base}/api/admin/import`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/images`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/images/1`, { method: 'DELETE' })).status, 401);
});

test('admin login reveals cost, can upload and delete images', async () => {
  const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'nope' }) });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'secret-pw' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  const H = { cookie };

  const { body } = await json(await fetch(`${base}/api/items?q=chair`, { headers: H }));
  assert.equal(body.items[0].avg_cost, 30);
  assert.equal(body.items[0].margin_pct, 100);
  assert.equal((await json(await fetch(`${base}/api/config`, { headers: H }))).body.isAdmin, true);

  // Bulk upload matched by file name; one unmatched; one wrong type.
  const fd = new FormData();
  fd.append('files', new File([PNG], 'dxb-20989_1.png', { type: 'image/png' }));
  fd.append('files', new File([PNG], 'nope.png', { type: 'image/png' }));
  fd.append('files', new File([Buffer.from('hi')], 'chair-1.txt', { type: 'text/plain' }));
  const up = await json(await fetch(`${base}/api/admin/images`, { method: 'POST', headers: H, body: fd }));
  assert.equal(up.status, 200);
  assert.equal(up.body.saved.length, 1);
  assert.equal(up.body.saved[0].sku, 'DXB-20989/1');
  assert.deepEqual(up.body.unmatched, ['nope.png']);
  assert.equal(up.body.rejected.length, 1);
  assert.ok(fs.existsSync(path.join(IMAGES_DIR, up.body.saved[0].filename)));

  // Explicit SKU upload.
  const fd2 = new FormData(); fd2.append('sku', 'CHAIR-1'); fd2.append('files', new File([PNG], 'anything.png', { type: 'image/png' }));
  const up2 = await json(await fetch(`${base}/api/admin/images`, { method: 'POST', headers: H, body: fd2 }));
  assert.equal(up2.body.saved[0].sku, 'CHAIR-1');

  // Public sees the image on the item and can fetch it.
  const item = (await json(await fetch(`${base}/api/items/${encodeURIComponent('DXB-20989/1')}`))).body;
  assert.equal(item.images.length, 1);
  assert.equal(item.image, item.images[0].filename);
  const img = await fetch(`${base}/images/${encodeURIComponent(item.image)}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await json(await fetch(`${base}/api/items?hasImage=1`))).body.total, 2);

  const del = await fetch(`${base}/api/admin/images/${item.images[0].id}`, { method: 'DELETE', headers: H });
  assert.equal(del.status, 200);
  assert.equal((await json(await fetch(`${base}/api/items/${encodeURIComponent('DXB-20989/1')}`))).body.images.length, 0);

  // Import via upload.
  const csv = 'Product,Description 1,Retail Price,Average cost\nCHAIR-1,Dining chair v2,95000,31\nNEW-1,New lamp,5000,2\n';
  const fd3 = new FormData(); fd3.append('file', new File([csv], 'list.csv', { type: 'text/csv' }));
  const imp = await json(await fetch(`${base}/api/admin/import`, { method: 'POST', headers: H, body: fd3 }));
  assert.equal(imp.status, 200);
  assert.deepEqual([imp.body.inserted, imp.body.updated], [1, 1]);
  assert.equal((await json(await fetch(`${base}/api/items/CHAIR-1`))).body.description, 'Dining chair v2');

  const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: H });
  assert.equal(out.status, 200);
});

test('unknown SKU is a 404 and item deep links serve the app', async () => {
  assert.equal((await fetch(`${base}/api/items/NOPE`)).status, 404);
  const page = await fetch(`${base}/item/${encodeURIComponent('DXB-20989/1')}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
});
