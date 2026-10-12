// "Snap to find": identify a catalog item from a photo by combining
//   1. a barcode visible in the photo,
//   2. text printed on the item (OCR, optionally Claude),
//   3. visual similarity to catalog photos (MobileNet embeddings).
import fs from 'node:fs';
import path from 'node:path';
import { IMAGES_DIR, VISUAL_SEARCH } from '../config.js';
import { embedImage, cosine, EMBED_DIM, getModel } from './embedder.js';
import { readText, extractTokens, shutdownOcr } from './ocr.js';
import { readBarcodes, barcodeVariants } from './barcode.js';
import { describeWithClaude, claudeEnabled } from './claude.js';

const PRIMARY_IMAGE_SQL = `(SELECT filename FROM images WHERE images.sku = items.sku ORDER BY sort_order, id LIMIT 1) AS image`;

// ---------------- embedding index (kept in memory, persisted in images.embedding) ----------------
export class PhotoIndex {
  constructor(db) {
    this.db = db;
    this.entries = []; // {id, sku, filename, vec}
    this.queue = []; this.running = false; this.failed = new Set();
    this.load();
  }
  load() {
    this.entries = this.db.prepare('SELECT id, sku, filename, embedding FROM images WHERE embedding IS NOT NULL').all()
      .map((r) => ({ id: r.id, sku: r.sku, filename: r.filename, vec: toFloat32(r.embedding) }))
      .filter((e) => e.vec && e.vec.length === EMBED_DIM);
  }
  get size() { return this.entries.length; }
  pending() { return this.db.prepare('SELECT COUNT(*) AS n FROM images WHERE embedding IS NULL').get().n; }
  remove(id) { this.entries = this.entries.filter((e) => e.id !== id); }
  /** Embed every photo that has no embedding yet. Runs in the background, one at a time. */
  async indexMissing() {
    if (this.running || !VISUAL_SEARCH) return;
    this.running = true;
    try {
      const rows = this.db.prepare('SELECT id, sku, filename FROM images WHERE embedding IS NULL').all();
      let done = 0;
      for (const row of rows) {
        if (this.failed.has(row.id)) continue;
        const file = path.join(IMAGES_DIR, row.filename);
        if (!fs.existsSync(file)) continue;
        try {
          const vec = await embedImage(fs.readFileSync(file));
          this.db.prepare('UPDATE images SET embedding = ? WHERE id = ?').run(Buffer.from(vec.buffer), row.id);
          this.remove(row.id);
          this.entries.push({ id: row.id, sku: row.sku, filename: row.filename, vec });
          done++;
        } catch (e) {
          this.failed.add(row.id);
          console.warn(`[vision] could not index ${row.filename}: ${e.message}`);
        }
      }
      if (done) console.log(`[vision] indexed ${done} photo(s), ${this.entries.length} in index`);
    } finally { this.running = false; }
  }
  /** Top matches for a query vector: best score per SKU. */
  similar(vec, limit = 12) {
    const best = new Map();
    for (const e of this.entries) {
      const s = cosine(vec, e.vec);
      const cur = best.get(e.sku);
      if (!cur || s > cur.score) best.set(e.sku, { sku: e.sku, filename: e.filename, score: s });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function toFloat32(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// ---------------- text matching ----------------
function escapeLike(s) { return s.replace(/[\\%_]/g, (m) => `\\${m}`); }

function findByToken(db, token, limit) {
  const t = token.toLowerCase();
  return db.prepare(
    `SELECT items.*, ${PRIMARY_IMAGE_SQL} FROM items WHERE search_text LIKE ? ESCAPE '\\'
     ORDER BY CASE WHEN lower(sku) = ? THEN 0 WHEN lower(sku) LIKE ? ESCAPE '\\' THEN 1 WHEN lower(description) LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END, description LIMIT ?`
  ).all(`%${escapeLike(t)}%`, t, `${escapeLike(t)}%`, `%${escapeLike(t)}%`, limit);
}

/** Looks up a list of weighted tokens; returns items ranked by the specificity of what matched. */
function matchTokens(db, tokens, { perToken = 25, limit = 16 } = {}) {
  const found = new Map(); // sku -> {item, score, matched[]}
  for (const { token, score, label } of tokens) {
    const rows = findByToken(db, token, perToken + 1);
    if (!rows.length || rows.length > perToken) continue; // too vague a token (e.g. "SMALL") or no hit
    const specificity = score * (1 + Math.min(token.length, 12) / 12) / Math.sqrt(rows.length);
    for (const row of rows) {
      const cur = found.get(row.sku) || { item: row, score: 0, matched: [] };
      cur.score += specificity;
      cur.matched.push(label || token);
      found.set(row.sku, cur);
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------- the pipeline ----------------
let busy = 0; const MAX_CONCURRENT = 2; const waiters = [];
async function withSlot(fn) {
  if (busy >= MAX_CONCURRENT) await new Promise((r) => waiters.push(r));
  busy++;
  try { return await fn(); } finally { busy--; const w = waiters.shift(); if (w) w(); }
}

export async function identify(db, index, buffer) {
  return withSlot(async () => {
    const timings = {}; const t = (k, t0) => { timings[k] = Date.now() - t0; };
    const t0 = Date.now();
    const [codes, ocrText, vec, ai] = await Promise.all([
      readBarcodes(buffer).catch((e) => { console.warn('[vision] barcode:', e.message); return []; }).then((r) => { t('barcode', t0); return r; }),
      readText(buffer).catch((e) => { console.warn('[vision] ocr:', e.message); return ''; }).then((r) => { t('ocr', t0); return r; }),
      VISUAL_SEARCH && index.size ? embedImage(buffer).catch((e) => { console.warn('[vision] embed:', e.message); return null; }).then((r) => { t('embed', t0); return r; }) : Promise.resolve(null),
      describeWithClaude(buffer).catch((e) => { console.warn('[vision] claude:', e.message); return null; }).then((r) => { t('claude', t0); return r; }),
    ]);

    // 1. Barcode
    const barcode = [];
    for (const c of codes) {
      const variants = barcodeVariants(c.text);
      const rows = db.prepare(`SELECT items.*, ${PRIMARY_IMAGE_SQL} FROM items WHERE barcode IN (${variants.map(() => '?').join(',')}) OR sku IN (${variants.map(() => '?').join(',')}) LIMIT 5`).all(...variants, ...variants);
      barcode.push({ code: c.text, format: c.format, items: rows });
    }

    // 2. Text on the item (OCR + Claude)
    const tokens = extractTokens(ocrText);
    const aiTokens = [];
    if (ai) {
      for (const m of ai.model_numbers) aiTokens.push({ token: m, score: 4, label: m });
      if (ai.brand) aiTokens.push({ token: ai.brand, score: 1.5, label: ai.brand });
      for (const k of ai.keywords) aiTokens.push({ token: k, score: 1, label: k });
      if (ai.product_type) for (const w of ai.product_type.split(/\s+/)) if (w.length >= 4) aiTokens.push({ token: w, score: 1, label: w });
      for (const w of ai.text_seen) if (/\d/.test(w) && w.length >= 4) aiTokens.push({ token: w, score: 2, label: w });
    }
    const merged = new Map();
    for (const tk of [...aiTokens, ...tokens]) { const k = tk.token.toUpperCase(); if (!merged.has(k) || merged.get(k).score < tk.score) merged.set(k, tk); }
    const text = matchTokens(db, [...merged.values()].slice(0, 40));

    // 3. Looks similar
    const similar = [];
    if (vec) {
      for (const m of index.similar(vec, 12)) {
        const item = db.prepare(`SELECT items.*, ${PRIMARY_IMAGE_SQL} FROM items WHERE sku = ?`).get(m.sku);
        if (item) similar.push({ item, score: m.score, filename: m.filename });
      }
    }
    timings.total = Date.now() - t0;
    return {
      barcode,
      text: { tokens: [...merged.values()].slice(0, 12).map((x) => x.label || x.token), items: text },
      similar,
      ai: ai ? { brand: ai.brand, model_numbers: ai.model_numbers, product_type: ai.product_type } : null,
      indexedPhotos: index.size,
      claudeEnabled: claudeEnabled(),
      timings,
    };
  });
}

/** Warm the model and OCR worker so the first snap is fast. Never throws. */
export async function warmUp(index) {
  if (!VISUAL_SEARCH) return;
  try { await getModel(); } catch (e) { console.warn('[vision] MobileNet unavailable, similar-photo search is off:', e.message); }
  index.indexMissing().catch(() => {});
}

/** Release background workers. Call on shutdown and at the end of tests. */
export async function shutdownVision() {
  await shutdownOcr();
}
