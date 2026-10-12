import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PORT, DATA_DIR, IMAGES_DIR, PUBLIC_DIR, SITE_NAME, RETAIL_CURRENCY, COST_CURRENCY, COST_LOCAL_CURRENCY, TRUST_PROXY, MAX_IMAGE_MB, MAX_IMPORT_MB } from './config.js';
import { openDatabase, getMeta } from './db.js';
import { parseWorkbook, importItems } from './importer.js';
import { searchItems, getItem, getFacets, getStats, stripAdminFields, stripInternalFields, buildSkuLookup, matchFilenameToSku } from './catalog.js';
import { attachAdmin, requireAdmin, checkCredentials, createToken, cookieOptions, COOKIE_NAME, adminEnabled, loginThrottle } from './auth.js';

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

export function createApp(db) {
  const app = express();
  if (TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(attachAdmin);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: 500 } });
  const uploadSheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_MB * 1024 * 1024, files: 1 } });

  const present = (req, item) => stripInternalFields(req.isAdmin ? item : stripAdminFields(item));

  // ---------- public API ----------
  app.get('/api/config', (req, res) => {
    res.json({
      siteName: SITE_NAME,
      isAdmin: req.isAdmin,
      adminEnabled: adminEnabled(),
      currencies: { retail: RETAIL_CURRENCY, cost: COST_CURRENCY, costLocal: COST_LOCAL_CURRENCY },
      stats: getStats(db),
      lastImport: getMeta(db, 'last_import'),
    });
  });

  app.get('/api/items', (req, res) => {
    const result = searchItems(db, {
      q: req.query.q ?? '',
      category: req.query.category ?? '',
      brand: req.query.brand ?? '',
      inStock: req.query.inStock === '1',
      hasImage: req.query.hasImage === '1',
      page: req.query.page,
      limit: req.query.limit,
    });
    result.items = result.items.map((it) => present(req, it));
    res.json(result);
  });

  app.get('/api/items/:sku', (req, res) => {
    const item = getItem(db, req.params.sku);
    if (!item) return res.status(404).json({ error: 'SKU not found.' });
    res.json(present(req, item));
  });

  app.get('/api/facets', (_req, res) => res.json(getFacets(db)));

  // ---------- auth ----------
  app.post('/api/login', loginThrottle, (req, res) => {
    const { username, password } = req.body || {};
    if (!checkCredentials(username, password)) return res.status(401).json({ error: 'Wrong username or password.' });
    res.cookie(COOKIE_NAME, createToken(), cookieOptions(req));
    res.json({ ok: true, isAdmin: true });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: undefined });
    res.json({ ok: true, isAdmin: false });
  });

  // ---------- admin API ----------
  app.post('/api/admin/import', requireAdmin, uploadSheet.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let parsed;
    try {
      parsed = parseWorkbook(req.file.buffer, req.file.originalname);
    } catch (e) {
      return res.status(400).json({ error: `Could not read the file: ${e.message}` });
    }
    const removeMissing = req.body.removeMissing === '1' || req.body.removeMissing === 'true';
    const result = importItems(db, parsed.items, { removeMissing });
    res.json({ ...result, sheet: parsed.sheet, columns: Object.keys(parsed.mapping) });
  });

  app.post('/api/admin/images', requireAdmin, uploadImage.array('files', 500), (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No images uploaded.' });
    const fixedSku = req.body.sku ? String(req.body.sku) : null;
    const lookup = buildSkuLookup(db);
    const insert = db.prepare('INSERT INTO images (sku, filename, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM images WHERE sku = ?))');
    const findSku = db.prepare('SELECT sku FROM items WHERE sku = ? COLLATE NOCASE');
    const report = { saved: [], unmatched: [], rejected: [] };
    fs.mkdirSync(IMAGES_DIR, { recursive: true });

    for (const file of files) {
      const ext = IMAGE_TYPES[file.mimetype];
      if (!ext) { report.rejected.push({ file: file.originalname, reason: 'Not a supported image type (jpg, png, webp, gif, avif).' }); continue; }
      let sku = null;
      if (fixedSku) {
        const row = findSku.get(fixedSku);
        sku = row ? row.sku : null;
      } else {
        sku = matchFilenameToSku(file.originalname, lookup);
      }
      if (!sku) { report.unmatched.push(file.originalname); continue; }
      const filename = `${sku.replace(/[^A-Za-z0-9._-]/g, '_')}__${crypto.randomBytes(5).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(IMAGES_DIR, filename), file.buffer);
      insert.run(sku, filename, sku);
      report.saved.push({ file: file.originalname, sku, filename });
    }
    res.json(report);
  });

  app.delete('/api/admin/images/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT filename FROM images WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Image not found.' });
    db.prepare('DELETE FROM images WHERE id = ?').run(id);
    fs.rm(path.join(IMAGES_DIR, row.filename), { force: true }, () => {});
    res.json({ ok: true });
  });

  app.post('/api/admin/images/:id/primary', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT sku FROM images WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Image not found.' });
    db.prepare('UPDATE images SET sort_order = sort_order + 1 WHERE sku = ?').run(row.sku);
    db.prepare('UPDATE images SET sort_order = 0 WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---------- static ----------
  app.use('/images', express.static(IMAGES_DIR, { maxAge: '7d', immutable: true, index: false, dotfiles: 'deny' }));
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));
  app.get('/item/*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // Error handler (multer limits, JSON parse errors, ...)
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large.' });
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const db = openDatabase();
  const app = createApp(db);
  app.listen(PORT, () => {
    console.log(`${SITE_NAME} listening on http://localhost:${PORT}  (data: ${DATA_DIR})`);
    const { items } = getStats(db);
    if (!items) console.log('Catalog is empty. Import your item list with: npm run import -- "path/to/Item list.xlsx"  (or log in as admin and use Import).');
  });
}
